//! Local machine metrics, used by the Dashboard when no remote host is selected.

use parking_lot::Mutex;
use sysinfo::{Components, Disks, Networks, ProcessRefreshKind, RefreshKind, System};

use crate::error::AppResult;
use crate::types::{DiskUsage, HostMetrics, ProcessInfo};

pub struct LocalMonitor {
    inner: Mutex<Inner>,
}

struct Inner {
    system: System,
    networks: Networks,
    /// Cumulative byte counters from the previous sample, for rate maths.
    prev_net: Option<(u64, u64, std::time::Instant)>,
}

impl Default for LocalMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalMonitor {
    pub fn new() -> Self {
        let system = System::new_with_specifics(
            RefreshKind::everything().with_processes(ProcessRefreshKind::everything()),
        );
        Self {
            inner: Mutex::new(Inner {
                system,
                networks: Networks::new_with_refreshed_list(),
                prev_net: None,
            }),
        }
    }

    pub fn sample(&self) -> AppResult<HostMetrics> {
        let mut guard = self.inner.lock();
        let inner = &mut *guard;

        inner.system.refresh_all();
        inner.networks.refresh(true);

        let sys = &inner.system;

        let mut m = HostMetrics {
            hostname: System::host_name().unwrap_or_else(|| "localhost".into()),
            os: System::long_os_version().unwrap_or_else(|| {
                System::name().unwrap_or_else(|| std::env::consts::OS.to_string())
            }),
            kernel: System::kernel_version().unwrap_or_default(),
            uptime_secs: System::uptime(),
            cpu_percent: sys.global_cpu_usage(),
            cpu_cores: sys.cpus().len() as u32,
            // Bytes -> KiB so the shape matches the remote /proc/meminfo path.
            mem_total_kb: sys.total_memory() / 1024,
            mem_used_kb: sys.used_memory() / 1024,
            swap_total_kb: sys.total_swap() / 1024,
            swap_used_kb: sys.used_swap() / 1024,
            sampled_at: chrono::Utc::now().timestamp_millis(),
            ..Default::default()
        };

        let load = System::load_average();
        m.load_avg = [load.one as f32, load.five as f32, load.fifteen as f32];

        // --- disks ---
        let disks = Disks::new_with_refreshed_list();
        for disk in disks.list() {
            let total = disk.total_space();
            if total == 0 {
                continue;
            }
            m.disks.push(DiskUsage {
                mount: disk.mount_point().to_string_lossy().to_string(),
                total_kb: total / 1024,
                used_kb: total.saturating_sub(disk.available_space()) / 1024,
                fs: disk.file_system().to_string_lossy().to_string(),
            });
        }
        m.disks.sort_by(|a, b| b.total_kb.cmp(&a.total_kb));
        m.disks.truncate(6);

        // --- network rates ---
        let (rx_total, tx_total) = inner.networks.iter().fold((0u64, 0u64), |(rx, tx), (_, d)| {
            (rx + d.total_received(), tx + d.total_transmitted())
        });
        let now = std::time::Instant::now();
        if let Some((prev_rx, prev_tx, prev_at)) = inner.prev_net {
            let secs = now.duration_since(prev_at).as_secs_f64().max(0.001);
            m.net_rx_bytes = ((rx_total.saturating_sub(prev_rx)) as f64 / secs) as u64;
            m.net_tx_bytes = ((tx_total.saturating_sub(prev_tx)) as f64 / secs) as u64;
        }
        inner.prev_net = Some((rx_total, tx_total, now));

        // --- temperature: prefer a package/CPU sensor, else the hottest one ---
        let components = Components::new_with_refreshed_list();
        let mut best: Option<f32> = None;
        for c in components.list() {
            let Some(temp) = c.temperature() else { continue };
            let label = c.label().to_lowercase();
            if label.contains("package") || label.contains("cpu") || label.contains("tctl") {
                best = Some(temp);
                break;
            }
            best = Some(best.map_or(temp, |b: f32| b.max(temp)));
        }
        m.temperature_c = best;

        // --- top processes by CPU ---
        let mut procs: Vec<ProcessInfo> = sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcessInfo {
                pid: pid.as_u32(),
                name: p.name().to_string_lossy().to_string(),
                cpu: p.cpu_usage(),
                mem_kb: p.memory() / 1024,
            })
            .collect();
        procs.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
        procs.truncate(8);
        m.processes = procs;

        Ok(m)
    }
}
