//! J-Link integration — a graphical front-end to SEGGER's J-Link Commander
//! (`JLinkExe`/`JLink.exe`) and J-Link GDB Server.
//!
//! This consolidates the everyday probe operations behind typed Tauri commands
//! so the UI can drive them with buttons instead of hand-typing commander
//! scripts:
//!
//! - `jlink_available`        — is the SEGGER software installed?
//! - `jlink_connect`          — open a target connection (device/if/speed)
//! - `jlink_reset`            — reset (+halt) / halt / go
//! - `jlink_read_mem`         — hex dump a memory range (`mem`)
//! - `jlink_write_mem`        — write bytes (`w1` per byte)
//! - `jlink_erase`            — mass-erase the flash (`erase`)
//! - `jlink_program`          — download a firmware image (`loadfile`)
//! - `jlink_gdb_start/stop`   — manage a J-Link GDB Server process
//! - `jlink_gdb_running`      — GDB Server liveness probe
//!
//! All one-shot operations are implemented by writing a temporary commander
//! script and invoking `JLinkExe -CommanderScript`. The GDB server is a
//! long-lived child process whose stdout/stderr are streamed back via the
//! `jlink-gdb-log` event.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::Child;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::error::{AppError, AppResult};

/// Windows process creation flag: run without allocating a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JLinkConfig {
    /// Target device name as understood by J-Link (e.g. `STM32F103C8`).
    pub device: String,
    /// Transport: `SWD` (default) or `JTAG`.
    pub iface: String,
    /// Interface speed in kHz; `0` means "auto".
    pub speed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JLinkResponse {
    pub success: bool,
    pub output: String,
}

/// Handle to the (optionally) running GDB server child process.
static GDB: Mutex<Option<Child>> = Mutex::new(None);

/// Locate the J-Link Commander executable across platforms.
///
/// `exe_path` is a user-configured override (a file, or a directory that
/// contains the J-Link executable). When it is `None` or empty we fall back to
/// scanning the SEGGER install directories — including *versioned* install
/// folders like `C:\Program Files\SEGGER\JLink_V798` or
/// `/opt/SEGGER/JLink_V7.98a`, which SEGGER creates per release — and finally
/// to a PATH lookup. When several installs exist, the newest version wins, so
/// upgrading/downgrading the SEGGER pack never breaks the auto-detection.
fn find_jlink(exe_path: Option<String>) -> Option<PathBuf> {
    // Honor an explicit, user-configured path first.
    if let Some(raw) = exe_path {
        let p = PathBuf::from(raw.trim());
        if !p.as_os_str().is_empty() {
            if p.is_file() {
                return Some(p);
            }
            if p.is_dir() {
                let probe = if cfg!(target_os = "windows") {
                    p.join("JLink.exe")
                } else {
                    p.join("JLinkExe")
                };
                if probe.is_file() {
                    return Some(probe);
                }
            }
        }
    }

    // Roots to scan. On Windows SEGGER installs under Program Files; on
    // macOS/Linux under /Applications or /opt. Bare `JLink` folders and
    // versioned folders (`JLink_V798`, `JLink_V7.98a`, …) both live directly
    // under these roots.
    let roots: Vec<PathBuf> = if cfg!(target_os = "windows") {
        vec![
            "C:\\Program Files (x86)\\SEGGER".into(),
            "C:\\Program Files\\SEGGER".into(),
        ]
    } else if cfg!(target_os = "macos") {
        vec!["/Applications/SEGGER".into(), "/opt/SEGGER".into()]
    } else {
        vec!["/opt/SEGGER".into()]
    };

    let mut found: Vec<PathBuf> = Vec::new();
    for root in &roots {
        if !root.is_dir() {
            continue;
        }
        // Direct children: `JLink.exe` sitting right in the SEGGER dir.
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && is_jlink_exe(&path) {
                    found.push(path);
                }
            }
        }
        // Versioned / bare subfolders: any dir whose name starts with `jlink`
        // (JLink, JLink_V798, JLink_V7.98a, JLink_V764e, …).
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if !name.starts_with("jlink") {
                    continue;
                }
                let probe = path.join(if cfg!(target_os = "windows") {
                    "JLink.exe"
                } else {
                    "JLinkExe"
                });
                if probe.is_file() {
                    found.push(probe);
                }
            }
        }
    }

    // Last resort: PATH lookup via `where` / `which`.
    let probe = if cfg!(target_os = "windows") {
        let mut c = std::process::Command::new("where");
        c.arg("JLink.exe");
        #[cfg(windows)]
        c.creation_flags(CREATE_NO_WINDOW);
        c.output()
    } else {
        std::process::Command::new("which").arg("JLinkExe").output()
    };
    if let Ok(out) = probe {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let path = PathBuf::from(line.trim());
                if path.is_file() && is_jlink_exe(&path) {
                    found.push(path);
                }
            }
        }
    }

    // Pick the best install: a versioned folder beats a bare `JLink` folder,
    // a higher version wins, and the file mtime breaks ties.
    found
        .into_iter()
        .max_by_key(|p| {
            let v = jlink_version_num(p);
            (v.is_some(), v.unwrap_or(0), file_mtime(p).unwrap_or(0))
        })
}

/// Is this file a J-Link Commander executable?
fn is_jlink_exe(p: &Path) -> bool {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name == "jlink.exe" || name == "jlinkexe.exe" || name == "jlinkexe"
}

/// Best-effort comparable version number derived from the install folder name:
/// `JLink_V798` → 798, `JLink_V7.98a` → 798, `JLink_V764e` → 764. Returns
/// `None` for a bare `JLink` folder so versioned installs are preferred.
fn jlink_version_num(p: &Path) -> Option<u64> {
    for comp in p.components().rev() {
        let s = comp.as_os_str().to_string_lossy().to_lowercase();
        if s.starts_with("jlink") {
            let digits: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
            return digits.parse().ok();
        }
    }
    None
}

/// File modification time as unix seconds (used as a tie-breaker).
fn file_mtime(p: &Path) -> Option<u64> {
    let meta = std::fs::metadata(p).ok()?;
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

fn exe_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// Curated fallback when the J-Link software (and its device database) is not
/// installed — a small set of common targets so the UI still has options.
fn curated_devices() -> Vec<String> {
    vec![
        "STM32F103C8".to_string(),
        "STM32F407VG".to_string(),
        "STM32L4".to_string(),
        "STM32H7".to_string(),
        "nRF52840_xxAA".to_string(),
        "nRF5340_xxAA".to_string(),
        "GD32F303".to_string(),
        "ATSAMD21G18".to_string(),
        "RP2040".to_string(),
        "MIMXRT1052".to_string(),
        "LPC1768".to_string(),
    ]
}

/// Extract every `Name="..."` attribute from a JLinkDevices.xml document.
fn parse_device_names(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (idx, _) in xml.match_indices("Name=\"") {
        let start = idx + 6;
        if let Some(rel) = xml[start..].find('"') {
            let name = xml[start..start + rel].trim();
            if !name.is_empty() {
                out.push(name.to_string());
            }
        }
    }
    out
}

/// Parse the output of `JLinkExe -DeviceList` (used only as a fallback when the
/// XML database is missing). Drops banner/header lines and keeps device-like
/// names.
fn parse_device_list_output(text: &str) -> Vec<String> {
    let skip = |l: &str| -> bool {
        let t = l.trim();
        if t.is_empty() || t.ends_with(':') {
            return true;
        }
        let low = t.to_lowercase();
        if low.contains("segger")
            || low.contains("j-link")
            || low.contains("jlink")
            || low.contains("supported")
            || low.contains("device")
            || low.contains("www.")
            || low.contains("dll")
            || low.contains("compiled")
            || low.contains("number of")
            || low.starts_with("----")
        {
            return true;
        }
        let all_valid = t.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '/' || c == '.' || c == '(' || c == ')'
        });
        !all_valid
    };
    text.lines().filter(|l| !skip(l)).map(|l| l.trim().to_string()).collect()
}

/// List every device supported by the installed J-Link driver. The authoritative
/// source is the `JLinkDevices.xml` database shipped next to the executable; if
/// that is missing we fall back to `JLinkExe -DeviceList`, and finally to a
/// small curated list when no J-Link software is installed at all.
#[tauri::command]
pub async fn jlink_devices(exe_path: Option<String>) -> AppResult<Vec<String>> {
    let exe = match find_jlink(exe_path) {
        Some(p) => p,
        None => return Ok(curated_devices()),
    };

    // Primary source: the device database shipped next to the executable.
    if let Some(dir) = exe.parent() {
        let xml = dir.join("JLinkDevices.xml");
        if let Ok(text) = std::fs::read_to_string(&xml) {
            let mut names: Vec<String> = parse_device_names(&text);
            if !names.is_empty() {
                names.sort();
                names.dedup();
                return Ok(names);
            }
        }
    }

    // Fallback: ask J-Link itself to list devices.
    let mut dl = tokio::process::Command::new(&exe);
    dl.arg("-DeviceList");
    #[cfg(windows)]
    dl.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    if let Ok(out) = dl.output().await {
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let mut names: Vec<String> = parse_device_list_output(&text);
        if !names.is_empty() {
            names.sort();
            names.dedup();
            return Ok(names);
        }
    }

    Ok(curated_devices())
}

#[tauri::command]
pub fn jlink_available(exe_path: Option<String>) -> bool {
    find_jlink(exe_path).is_some()
}

/// Map the transport name to J-Link's `si` selector (0 = JTAG, 1 = SWD).
fn iface_code(iface: &str) -> u8 {
    if iface.eq_ignore_ascii_case("jtag") {
        0
    } else {
        1
    }
}

/// Parse an address like `0x20000000` / `20000000` / `0X1FFF_F000`.
fn parse_addr(s: &str) -> Result<u64, AppError> {
    let t = s.trim().replace('_', "");
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(&t);
    u64::from_str_radix(t, 16)
        .or_else(|_| t.parse::<u64>())
        .map_err(|_| AppError::Other(format!("无效的地址: {s}")))
}

/// Parse a list of hex bytes separated by spaces/commas, e.g. `0x12 34 AB, 0xFF`.
fn parse_hex_bytes(s: &str) -> Result<Vec<u8>, AppError> {
    let mut out = Vec::new();
    for tok in s.split(|c| c == ' ' || c == ',' || c == '\n' || c == '\t') {
        let tok = tok.trim();
        if tok.is_empty() {
            continue;
        }
        let t = tok.strip_prefix("0x").or_else(|| tok.strip_prefix("0X")).unwrap_or(tok);
        let v = u32::from_str_radix(t, 16)
            .map_err(|_| AppError::Other(format!("无效的十六进制字节: {tok}")))?;
        if v > 0xFF {
            return Err(AppError::Other(format!("字节超出范围 (0-0xFF): {tok}")));
        }
        out.push(v as u8);
    }
    if out.is_empty() {
        return Err(AppError::Other("至少需要一个字节".into()));
    }
    Ok(out)
}

/// Build the connection prefix (device/if/speed/connect) for a script.
fn connect_prefix(config: &JLinkConfig) -> String {
    let mut s = String::new();
    if !config.device.trim().is_empty() {
        s.push_str(&format!("device {}\n", config.device.trim()));
        s.push_str(&format!("si {}\n", iface_code(&config.iface)));
        if config.speed > 0 {
            s.push_str(&format!("speed {}\n", config.speed));
        } else {
            s.push_str("speed auto\n");
        }
        s.push_str("connect\n");
    }
    s
}

/// Write `script` to a temp file and run it through JLinkExe.
async fn run_script(
    config: &JLinkConfig,
    body: &[String],
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    let exe = find_jlink(exe_path).ok_or_else(|| AppError::Other(
        "未找到 J-Link 软件（JLink.exe / JLinkExe）。请先安装 SEGGER J-Link Software and Documentation Pack，\n\
         并确保其位于 PATH 或默认安装目录（如 C:\\Program Files (x86)\\SEGGER\\JLink）。".into(),
    ))?;

    let mut script = connect_prefix(config);
    for line in body {
        script.push_str(line);
        script.push('\n');
    }
    script.push_str("exit\n");

    let script_path = std::env::temp_dir().join(format!("devops-jlink-{}.jlink", std::process::id()));
    {
        let mut f = std::fs::File::create(&script_path)
            .map_err(|e| AppError::Other(format!("无法创建临时脚本: {e}")))?;
        f.write_all(script.as_bytes())
            .map_err(|e| AppError::Other(format!("无法写入临时脚本: {e}")))?;
    }

    let mut rs = tokio::process::Command::new(&exe);
    rs.arg("-CommanderScript")
        .arg(&script_path)
        .arg("-ExitOnError");
    #[cfg(windows)]
    rs.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    let output = rs
        .output()
        .await
        .map_err(|e| AppError::Other(format!("执行 JLink 失败: {e}")))?;

    let _ = std::fs::remove_file(&script_path);

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let combined = if stderr.trim().is_empty() {
        stdout
    } else {
        format!("{stdout}\n{stderr}")
    };
    let success = output.status.success() && !combined.contains("ERROR:");
    Ok(JLinkResponse {
        success,
        output: combined,
    })
}

#[tauri::command]
pub async fn jlink_connect(
    config: JLinkConfig,
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    let empty: &[String] = &[];
    run_script(&config, empty, exe_path).await
}

#[tauri::command]
pub async fn jlink_reset(
    config: JLinkConfig,
    mode: String,
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    let cmd = match mode.to_lowercase().as_str() {
        "go" => "g",   // run
        "halt" => "h", // halt
        _ => "r",      // reset + halt
    };
    run_script(&config, &[cmd.to_string()], exe_path).await
}

#[tauri::command]
pub async fn jlink_read_mem(
    config: JLinkConfig,
    addr: String,
    len: u32,
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    if len == 0 {
        return Err(AppError::Other("长度必须为正整数".into()));
    }
    let body = vec![format!("mem {:#x}, {}", parse_addr(&addr)?, len)];
    run_script(&config, &body, exe_path).await
}

#[tauri::command]
pub async fn jlink_write_mem(
    config: JLinkConfig,
    addr: String,
    data: String,
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    let base = parse_addr(&addr)?;
    let bytes = parse_hex_bytes(&data)?;
    let body: Vec<String> = bytes
        .iter()
        .enumerate()
        .map(|(i, b)| format!("w1 {:#x}, {:#x}", base + i as u64, *b as u64))
        .collect();
    run_script(&config, &body, exe_path).await
}

#[tauri::command]
pub async fn jlink_erase(
    config: JLinkConfig,
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    run_script(&config, &["erase".to_string()], exe_path).await
}

#[tauri::command]
pub async fn jlink_program(
    config: JLinkConfig,
    file: String,
    addr: Option<String>,
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    if !Path::new(&file).is_file() {
        return Err(AppError::Other(format!("固件文件不存在: {file}")));
    }
    let body = match addr {
        Some(a) => vec![format!("loadfile {file}, {:#x}", parse_addr(&a)?)],
        None => vec![format!("loadfile {file}")],
    };
    run_script(&config, &body, exe_path).await
}

// ===========================================================================
// GDB Server (long-lived child process)
// ===========================================================================

#[tauri::command]
pub async fn jlink_gdb_start(
    app: tauri::AppHandle,
    config: JLinkConfig,
    port: u32,
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    let exe = find_jlink(exe_path).ok_or_else(|| AppError::Other("未找到 J-Link 软件".into()))?;
    let gdb = exe.with_file_name(exe_name("JLinkGDBServer"));
    if !gdb.is_file() {
        return Err(AppError::Other(format!("未找到 JLinkGDBServer: {}", gdb.display())));
    }

    // Refuse to start a second instance.
    {
        let mut g = GDB.lock();
        if let Some(c) = g.as_mut() {
            if c.try_wait().map(|s| s.is_none()).unwrap_or(false) {
                return Err(AppError::Other("GDB Server 已在运行".into()));
            }
        }
    }

    let mut cmd = std::process::Command::new(&gdb);
    cmd.arg("-device").arg(&config.device);
    cmd.arg("-if")
        .arg(if config.iface.eq_ignore_ascii_case("jtag") { "JTAG" } else { "SWD" });
    if config.speed > 0 {
        cmd.arg("-speed").arg(config.speed.to_string());
    }
    cmd.arg("-port").arg(port.to_string());
    cmd.arg("-nogui");
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("启动 GDB Server 失败: {e}")))?;

    // Stream stdout/stderr to the frontend as `jlink-gdb-log` events.
    if let Some(out) = child.stdout.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().flatten() {
                let _ = app2.emit("jlink-gdb-log", line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
                let _ = app2.emit("jlink-gdb-log", line);
            }
        });
    }

    *GDB.lock() = Some(child);
    Ok(JLinkResponse {
        success: true,
        output: format!("GDB Server 已启动，端口 {port}"),
    })
}

#[tauri::command]
pub async fn jlink_gdb_stop() -> AppResult<JLinkResponse> {
    let mut g = GDB.lock();
    match g.take() {
        Some(mut c) => {
            let _ = c.kill();
            let _ = c.wait();
            Ok(JLinkResponse {
                success: true,
                output: "GDB Server 已停止".into(),
            })
        }
        None => Ok(JLinkResponse {
            success: false,
            output: "GDB Server 未运行".into(),
        }),
    }
}

#[tauri::command]
pub async fn jlink_gdb_running() -> bool {
    let mut g = GDB.lock();
    match g.as_mut() {
        Some(c) => {
            let alive = c.try_wait().map(|s| s.is_none()).unwrap_or(false);
            if !alive {
                *g = None; // reap dead handle
            }
            alive
        }
        None => false,
    }
}
