//! Agentless remote monitoring.
//!
//! Everything is gathered with one round-trip running a single POSIX shell
//! probe. Nothing is installed on the target — if a file or tool is missing the
//! corresponding section simply comes back empty and the field stays at zero.
//!
//! CPU% and network throughput are rates, so they need two samples. We keep the
//! previous reading per session and diff against it, which means the first call
//! after connecting reports 0 and every later call is accurate for whatever
//! interval the UI happens to poll at.

use std::collections::HashMap;
use std::time::Instant;

use tokio::sync::RwLock;

use crate::error::AppResult;
use crate::ssh::SshSession;
use crate::types::{DiskUsage, HostMetrics, ProcessInfo};

/// One shell round-trip; sections are delimited by `@@X` markers.
const PROBE: &str = r#"
echo '@@H'; hostname 2>/dev/null
echo '@@O'; grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"'; uname -s 2>/dev/null
echo '@@K'; uname -r 2>/dev/null
echo '@@U'; cut -d' ' -f1 /proc/uptime 2>/dev/null
echo '@@L'; cut -d' ' -f1-3 /proc/loadavg 2>/dev/null
echo '@@C'; grep -c '^processor' /proc/cpuinfo 2>/dev/null
echo '@@S'; grep '^cpu ' /proc/stat 2>/dev/null
echo '@@M'; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
echo '@@D'; df -kP 2>/dev/null | tail -n +2
echo '@@N'; tail -n +3 /proc/net/dev 2>/dev/null
echo '@@T'; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -1
echo '@@P'; ps -eo pid=,pcpu=,rss=,comm= 2>/dev/null | sort -k2 -nr | head -8
echo '@@E'
"#;

#[derive(Clone, Copy)]
struct Sample {
    cpu_idle: u64,
    cpu_total: u64,
    net_rx: u64,
    net_tx: u64,
    at: Instant,
}

#[derive(Default)]
pub struct MetricsCache {
    previous: RwLock<HashMap<String, Sample>>,
}

impl MetricsCache {
    pub async fn forget(&self, session_id: &str) {
        self.previous.write().await.remove(session_id);
    }
}

pub async fn collect(session: &SshSession, cache: &MetricsCache) -> AppResult<HostMetrics> {
    let raw = session.exec(PROBE).await?;
    let sections = split_sections(&raw);

    let mut m = HostMetrics {
        hostname: first_line(sections.get("H")).unwrap_or_else(|| session.hostname.clone()),
        os: first_line(sections.get("O")).unwrap_or_else(|| "unknown".into()),
        kernel: first_line(sections.get("K")).unwrap_or_default(),
        sampled_at: chrono::Utc::now().timestamp_millis(),
        ..Default::default()
    };

    m.uptime_secs = first_line(sections.get("U"))
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;

    if let Some(load) = first_line(sections.get("L")) {
        let parts: Vec<f32> = load
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        for (i, v) in parts.iter().take(3).enumerate() {
            m.load_avg[i] = *v;
        }
    }

    m.cpu_cores = first_line(sections.get("C"))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    // --- CPU jiffies ---
    let (cpu_idle, cpu_total) = sections
        .get("S")
        .and_then(|s| s.first())
        .map(|line| parse_cpu_line(line))
        .unwrap_or((0, 0));

    // --- Memory ---
    let mem = parse_meminfo(sections.get("M"));
    m.mem_total_kb = mem.get("MemTotal").copied().unwrap_or(0);
    let available = mem.get("MemAvailable").copied().unwrap_or_else(|| {
        // Older kernels: approximate with free + buffers + cached.
        mem.get("MemFree").copied().unwrap_or(0)
            + mem.get("Buffers").copied().unwrap_or(0)
            + mem.get("Cached").copied().unwrap_or(0)
    });
    m.mem_used_kb = m.mem_total_kb.saturating_sub(available);
    m.swap_total_kb = mem.get("SwapTotal").copied().unwrap_or(0);
    m.swap_used_kb = m
        .swap_total_kb
        .saturating_sub(mem.get("SwapFree").copied().unwrap_or(0));

    // --- Disks ---
    if let Some(lines) = sections.get("D") {
        for line in lines {
            let f: Vec<&str> = line.split_whitespace().collect();
            // Filesystem 1024-blocks Used Available Capacity Mounted-on
            if f.len() < 6 {
                continue;
            }
            let fs = f[0].to_string();
            // Skip pseudo filesystems — they only add noise to the dashboard.
            if fs.starts_with("tmpfs")
                || fs.starts_with("devtmpfs")
                || fs.starts_with("overlay")
                || fs == "none"
            {
                continue;
            }
            let total: u64 = f[1].parse().unwrap_or(0);
            let used: u64 = f[2].parse().unwrap_or(0);
            if total == 0 {
                continue;
            }
            m.disks.push(DiskUsage {
                mount: f[5..].join(" "),
                total_kb: total,
                used_kb: used,
                fs,
            });
        }
        m.disks.sort_by(|a, b| b.total_kb.cmp(&a.total_kb));
        m.disks.truncate(6);
    }

    // --- Network counters ---
    let (net_rx, net_tx) = sections
        .get("N")
        .map(|lines| parse_net(lines))
        .unwrap_or((0, 0));

    // --- Temperature ---
    m.temperature_c = first_line(sections.get("T"))
        .and_then(|s| s.parse::<f32>().ok())
        // thermal_zone reports milli-degrees on virtually every board.
        .map(|v| if v > 200.0 { v / 1000.0 } else { v });

    // --- Processes ---
    if let Some(lines) = sections.get("P") {
        for line in lines {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() < 4 {
                continue;
            }
            m.processes.push(ProcessInfo {
                pid: f[0].parse().unwrap_or(0),
                cpu: f[1].parse().unwrap_or(0.0),
                mem_kb: f[2].parse().unwrap_or(0),
                name: f[3..].join(" "),
            });
        }
    }

    // --- Rates, diffed against the previous sample ---
    let now = Instant::now();
    let current = Sample {
        cpu_idle,
        cpu_total,
        net_rx,
        net_tx,
        at: now,
    };

    if let Some(prev) = cache.previous.read().await.get(&session.id).copied() {
        let d_total = cpu_total.saturating_sub(prev.cpu_total);
        let d_idle = cpu_idle.saturating_sub(prev.cpu_idle);
        if d_total > 0 {
            m.cpu_percent = (100.0 * (1.0 - d_idle as f32 / d_total as f32)).clamp(0.0, 100.0);
        }
        let secs = now.duration_since(prev.at).as_secs_f64().max(0.001);
        m.net_rx_bytes = ((net_rx.saturating_sub(prev.net_rx)) as f64 / secs) as u64;
        m.net_tx_bytes = ((net_tx.saturating_sub(prev.net_tx)) as f64 / secs) as u64;
    }

    cache
        .previous
        .write()
        .await
        .insert(session.id.clone(), current);

    Ok(m)
}

// --- parsing helpers -------------------------------------------------------

fn split_sections(raw: &str) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let mut current = String::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(tag) = line.trim().strip_prefix("@@") {
            current = tag.to_string();
            out.entry(current.clone()).or_default();
            continue;
        }
        if current.is_empty() || line.trim().is_empty() {
            continue;
        }
        out.entry(current.clone()).or_default().push(line.to_string());
    }
    out
}

fn first_line(section: Option<&Vec<String>>) -> Option<String> {
    section?
        .iter()
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// `cpu  user nice system idle iowait irq softirq steal ...`
fn parse_cpu_line(line: &str) -> (u64, u64) {
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse().ok())
        .collect();
    let total: u64 = values.iter().sum();
    // idle + iowait
    let idle = values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0);
    (idle, total)
}

fn parse_meminfo(section: Option<&Vec<String>>) -> HashMap<String, u64> {
    let mut map = HashMap::new();
    let Some(lines) = section else { return map };
    for line in lines {
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let kb = rest
            .split_whitespace()
            .next()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        map.insert(key.trim().to_string(), kb);
    }
    map
}

/// `iface: rx_bytes rx_packets ... tx_bytes ...` — field 0 is rx, field 8 is tx.
fn parse_net(lines: &[String]) -> (u64, u64) {
    let mut rx = 0u64;
    let mut tx = 0u64;
    for line in lines {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = iface.trim();
        if iface == "lo" || iface.starts_with("docker") || iface.starts_with("veth") {
            continue;
        }
        let f: Vec<u64> = rest
            .split_whitespace()
            .map(|v| v.parse().unwrap_or(0))
            .collect();
        if f.len() >= 9 {
            rx += f[0];
            tx += f[8];
        }
    }
    (rx, tx)
}
