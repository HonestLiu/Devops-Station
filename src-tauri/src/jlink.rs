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
//! - `jlink_rtt_start/stop`    — RTT: a J-Link Commander + JLinkRTTClient pair
//! - `jlink_rtt_running`      — RTT pipe liveness probe
//! - `jlink_rtt_send`         — write terminal input to RTT channel 0
//!
//! All one-shot operations are implemented by writing a temporary commander
//! script and invoking `JLinkExe -CommanderScript`. The GDB server is a
//! long-lived child process whose stdout/stderr are streamed back via the
//! `jlink-gdb-log` event. RTT uses a long-lived subprocess pair: J-Link
//! Commander hosts the RTT server on TCP 19021, and `JLinkRTTClient` pipes
//! channel-0 bytes (stdout) / input (stdin), streamed back via the
//! `jlink-rtt-data` (base64 chunks) and `jlink-rtt-log` (diagnostics) events.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use base64::Engine as _;
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

/// Cached "last successful connect" snapshot. The probe connection itself is
/// one-shot per script run (Commander connects, runs the body, disconnects,
/// exits), so there's no long-lived session to introspect. Instead we
/// remember the last config the user successfully connected with — plus any
/// extra info we could scrape from Commander's banner — so the UI can show a
/// meaningful "Connected to X via Y @ Z" badge and a Disconnect button that
/// clears the cache (and the local view) without lying about a connection
/// that was never persistent.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct JLinkStatus {
    /// Last device the user successfully connected to (e.g. `STM32F103C8`).
    pub device: String,
    /// Transport — `SWD` or `JTAG`.
    pub iface: String,
    /// Interface speed in kHz; `0` means auto.
    pub speed: u32,
    /// Probe serial number scraped from the connect banner, if available.
    pub serial: Option<String>,
    /// Unix seconds of the last successful connect.
    pub connected_at: u64,
}

static LAST_CONNECT: Mutex<Option<JLinkStatus>> = Mutex::new(None);

/// Pull the probe serial number out of a typical connect banner:
/// `S/N: 30500729`. Best-effort — if the banner is missing or in another
/// locale we just return `None` rather than failing the whole connect.
fn extract_serial(output: &str) -> Option<String> {
    for line in output.lines() {
        let t = line.trim_start();
        let after = t.strip_prefix("S/N:").or_else(|| t.strip_prefix("S/N"));
        if let Some(rest) = after {
            let digits: String = rest.trim().chars().take_while(|c| !c.is_whitespace()).collect();
            if !digits.is_empty() {
                return Some(digits);
            }
        }
    }
    None
}

/// Handle to the (optionally) running GDB server child process.
static GDB: Mutex<Option<Child>> = Mutex::new(None);

/// Long-lived J-Link Commander process hosting the RTT Server on TCP 19021.
static RTT_HOST: Mutex<Option<Child>> = Mutex::new(None);
/// Long-lived `JLinkRTTClient` pipe: stdout = RTT channel-0 bytes up, stdin =
/// channel-0 input down.
static RTT_CLIENT: Mutex<Option<Child>> = Mutex::new(None);

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

/// Curated fallback when the J-Link software's device database cannot be read
/// (e.g. J-Link V7.98 ships device names inside `JLinkARM.dll` and has no
/// standalone `JLinkDevices.xml`, and does not support the `-DeviceList` CLI
/// flag). A broad set of common targets so the UI still has useful options —
/// users can always type an exact model name into the datalist input.
fn curated_devices() -> Vec<String> {
    let mut v = vec![
        // --- ST STM32 ---
        "STM32F030".to_string(),
        "STM32F031".to_string(),
        "STM32F051".to_string(),
        "STM32F072".to_string(),
        "STM32F100".to_string(),
        "STM32F103C8".to_string(),
        "STM32F103RB".to_string(),
        "STM32F103RE".to_string(),
        "STM32F103ZE".to_string(),
        "STM32F105".to_string(),
        "STM32F107".to_string(),
        "STM32F205".to_string(),
        "STM32F207".to_string(),
        "STM32F303".to_string(),
        "STM32F334".to_string(),
        "STM32F373".to_string(),
        "STM32F401".to_string(),
        "STM32F405".to_string(),
        "STM32F407VG".to_string(),
        "STM32F407ZE".to_string(),
        "STM32F411".to_string(),
        "STM32F412".to_string(),
        "STM32F429".to_string(),
        "STM32F446".to_string(),
        "STM32F469".to_string(),
        "STM32F722".to_string(),
        "STM32F746".to_string(),
        "STM32F767".to_string(),
        "STM32F777".to_string(),
        "STM32F103".to_string(),
        "STM32F4".to_string(),
        "STM32F7".to_string(),
        "STM32G031".to_string(),
        "STM32G071".to_string(),
        "STM32G431".to_string(),
        "STM32G474".to_string(),
        "STM32G0".to_string(),
        "STM32G4".to_string(),
        "STM32H743".to_string(),
        "STM32H750".to_string(),
        "STM32H7".to_string(),
        "STM32L031".to_string(),
        "STM32L072".to_string(),
        "STM32L151".to_string(),
        "STM32L152".to_string(),
        "STM32L432".to_string(),
        "STM32L433".to_string(),
        "STM32L4".to_string(),
        "STM32L0".to_string(),
        "STM32U5".to_string(),
        "STM32WB55".to_string(),
        "STM32MP1".to_string(),
        // --- GigaDevice GD32 ---
        "GD32F103".to_string(),
        "GD32F303".to_string(),
        "GD32F305".to_string(),
        "GD32F350".to_string(),
        "GD32F450".to_string(),
        "GD32E230".to_string(),
        "GD32F1".to_string(),
        "GD32F3".to_string(),
        // --- Nordic nRF ---
        "nRF51822".to_string(),
        "nRF52810".to_string(),
        "nRF52832".to_string(),
        "nRF52840_xxAA".to_string(),
        "nRF5340_xxAA".to_string(),
        "nRF9160_xxAA".to_string(),
        // --- NXP ---
        "MIMXRT1052".to_string(),
        "MIMXRT1062".to_string(),
        "MIMXRT1064".to_string(),
        "MIMXRT1176".to_string(),
        "LPC1768".to_string(),
        "LPC1769".to_string(),
        "LPC11U35".to_string(),
        "LPC804".to_string(),
        "MK20DX256".to_string(),
        "MK64FN1M0".to_string(),
        "K64F".to_string(),
        "MKE18F".to_string(),
        // --- Microchip / Atmel ---
        "ATSAMD21G18".to_string(),
        "ATSAMD21E18".to_string(),
        "ATSAMD51".to_string(),
        "ATSAMD11".to_string(),
        "ATSAM3X8E".to_string(),
        "ATSAM4S".to_string(),
        "ATmega328P".to_string(),
        "ATmega2560".to_string(),
        "ATtiny85".to_string(),
        // --- Raspberry Pi / RP family ---
        "RP2040".to_string(),
        "RP2350".to_string(),
        "RaspberryPi".to_string(),
        // --- Espressif ---
        "ESP32".to_string(),
        "ESP32C3".to_string(),
        "ESP32S3".to_string(),
        "ESP8266".to_string(),
        // --- Silicon Labs / EFM32 ---
        "EFM32GG".to_string(),
        "EFM32HG".to_string(),
        "EFR32BG13".to_string(),
        "EFR32MG21".to_string(),
        // --- TI ---
        "TM4C123GH6PM".to_string(),
        "CC2650".to_string(),
        "CC3220".to_string(),
        "MSP432".to_string(),
        // --- Infineon / Cypress ---
        "XMC1100".to_string(),
        "XMC4200".to_string(),
        "XMC4400".to_string(),
        "XMC4700".to_string(),
        "CY8C5868".to_string(),
        "PSoC6".to_string(),
        // --- Renesas ---
        "R5F5111".to_string(),
        "RA6M3".to_string(),
        "RX65N".to_string(),
        // --- Toshiba / others ---
        "TMPM3H".to_string(),
        "M481".to_string(),
        "M031".to_string(),
    ];
    v.sort();
    v.dedup();
    v
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

    // Primary source: the device database. SEGGER ships `JLinkDevices.xml` in
    // different places depending on the version — directly next to the exe, in
    // an `ETC/` subfolder, next to the DLL, or sometimes one level up. Probe
    // all of those before giving up.
    let mut xml_candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe.parent() {
        xml_candidates.push(dir.join("JLinkDevices.xml"));
        xml_candidates.push(dir.join("ETC").join("JLinkDevices.xml"));
        xml_candidates.push(dir.join("JLinkARM.dll").with_file_name("JLinkDevices.xml"));
        if let Some(parent) = dir.parent() {
            xml_candidates.push(parent.join("JLinkDevices.xml"));
        }
    }
    xml_candidates.dedup();
    for xml in xml_candidates {
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
        // `ExitOnError` is a *commander-script command*, not a CLI option.
        // Passing it as `-ExitOnError` on the command line makes J-Link
        // Commander bail with "Missing command line parameter after command"
        // before doing anything. Emit it as a script line instead, and pass
        // the required `1` argument — without it Commander prints
        // `Syntax: ExitonError <1|0>` and silently leaves the flag at its
        // default (off), so a failed `connect` would still let later commands
        // like `loadfile` run instead of aborting the script.
        s.push_str("ExitOnError 1\n");
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
    rs.arg("-CommanderScript").arg(&script_path);
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
    let res = run_script(&config, empty, exe_path).await?;
    if res.success && !config.device.trim().is_empty() {
        // Cache the (client-side) "last connect" so the UI badge + Disconnect
        // button have something to render. We only cache when the device
        // field is filled in, otherwise the connect was a no-op probe-check.
        let status = JLinkStatus {
            device: config.device.trim().to_string(),
            iface: config.iface.clone(),
            speed: config.speed,
            serial: extract_serial(&res.output),
            connected_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        };
        *LAST_CONNECT.lock() = Some(status);
    }
    Ok(res)
}

/// Return the cached "last successful connect" snapshot, or a default empty
/// status when nothing has been connected yet. The frontend uses this to
/// render the connection badge in the workspace header.
#[tauri::command]
pub fn jlink_status() -> JLinkStatus {
    LAST_CONNECT.lock().clone().unwrap_or_default()
}

/// Clear the cached "last successful connect" snapshot. The frontend calls
/// this when the user clicks Disconnect in the workspace header so the badge
/// flips back to "Not connected". (There is no actual probe-side connection
/// to tear down — every operation is a one-shot script — but the UI now
/// behaves like a real session lifecycle.)
#[tauri::command]
pub fn jlink_disconnect() -> JLinkStatus {
    *LAST_CONNECT.lock() = None;
    JLinkStatus::default()
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
// External tools (launcher)
// ===========================================================================

/// SEGGER GUI tools that ship next to the J-Link Commander executable, keyed
/// for the launcher UI (`JLinkToolsWorkspace`).
const JLINK_TOOLS: &[(&str, &str)] = &[
    ("config", "JLinkConfig"),
    ("jflash", "JFlash"),
    ("swo", "JLinkSWOViewer"),
    ("rttviewer", "JLinkRTTViewer"),
];

/// Launch one of SEGGER's J-Link GUI tools (J-Link Config, J-Flash, SWO / RTT
/// Viewer) in its own window. Fire-and-forget: the tool owns its lifecycle.
#[tauri::command]
pub async fn jlink_launch_tool(
    tool: String,
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    let base = JLINK_TOOLS
        .iter()
        .find(|(k, _)| *k == tool)
        .map(|(_, b)| *b)
        .ok_or_else(|| AppError::Other(format!("未知的工具: {tool}")))?;
    let exe = find_jlink(exe_path).ok_or_else(|| AppError::Other("未找到 J-Link 软件".into()))?;
    let tool_path = exe.with_file_name(exe_name(base));
    if !tool_path.is_file() {
        return Err(AppError::Other(format!(
            "未找到 {base}（{}），可能未随当前 J-Link 版本安装。",
            tool_path.display()
        )));
    }
    let mut cmd = std::process::Command::new(&tool_path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
        .map_err(|e| AppError::Other(format!("启动 {base} 失败: {e}")))?;
    Ok(JLinkResponse {
        success: true,
        output: format!("{base} 已启动"),
    })
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

// ===========================================================================
// RTT — a long-lived subprocess PAIR. J-Link Commander owns the probe
// connection and hosts the RTT Server on TCP 19021 (`RTTClient` command);
// `JLinkRTTClient` (a pure console pipe) connects to it, so its stdout is a
// clean RTT channel-0 byte stream (base64'd in 4 KB chunks) and its stdin is
// the channel-0 input path.
// ===========================================================================

/// Default RTT server TCP port hosted by J-Link Commander's `RTTClient` command.
const RTT_SERVER_PORT: u16 = 19021;

#[tauri::command]
pub async fn jlink_rtt_start(
    app: tauri::AppHandle,
    config: JLinkConfig,
    exe_path: Option<String>,
) -> AppResult<JLinkResponse> {
    let exe = find_jlink(exe_path).ok_or_else(|| AppError::Other("未找到 J-Link 软件".into()))?;

    // Refuse to start a second instance.
    {
        let mut h = RTT_HOST.lock();
        if let Some(c) = h.as_mut() {
            if c.try_wait().map(|s| s.is_none()).unwrap_or(false) {
                return Err(AppError::Other("RTT 已在运行".into()));
            }
        }
    }

    // The companion console client lives next to the Commander executable.
    let client = exe.with_file_name(exe_name("JLinkRTTClient"));
    if !client.is_file() {
        return Err(AppError::Other(format!(
            "未找到 JLinkRTTClient: {}",
            client.display()
        )));
    }

    // --- Host: J-Link Commander owns the probe connection + RTT server -------
    let mut script = connect_prefix(&config);
    script.push_str("RTTClient\n");
    script.push_str("Sleep 0xFFFFFFFF\n");
    script.push_str("exit\n");

    let script_path = std::env::temp_dir().join(format!(
        "devops-jlink-rtt-{}.jlink",
        std::process::id()
    ));
    {
        let mut f = std::fs::File::create(&script_path)
            .map_err(|e| AppError::Other(format!("无法创建临时脚本: {e}")))?;
        f.write_all(script.as_bytes())
            .map_err(|e| AppError::Other(format!("无法写入临时脚本: {e}")))?;
    }

    let host_log: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let mut cmd = std::process::Command::new(&exe);
    cmd.arg("-CommanderScript").arg(&script_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut host = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("启动 J-Link Commander 失败: {e}")))?;

    // Buffer host stdout/stderr so an early exit can be reported with the
    // captured text. Deliberately NOT streamed to `jlink-rtt-log`: Commander's
    // RTTClient may echo channel-0 data to its own console, which would double
    // the RTT output once the client pipe is also streaming it.
    if let Some(out) = host.stdout.take() {
        let buf = host_log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().flatten() {
                buf.lock().push_str(&line);
                buf.lock().push('\n');
            }
        });
    }
    if let Some(err) = host.stderr.take() {
        let buf = host_log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
                buf.lock().push_str(&line);
                buf.lock().push('\n');
            }
        });
    }

    // Early-exit detection: with no probe/target attached, Commander prints its
    // banner + ERROR and quits — surface that instead of a hanging "running"
    // state. ~2.5s @ 100ms is enough to consider the server stable.
    let mut waited = 0u32;
    loop {
        match host.try_wait() {
            Ok(Some(status)) => {
                let _ = std::fs::remove_file(&script_path);
                let out = host_log.lock().clone();
                return Ok(JLinkResponse {
                    success: false,
                    output: format!("RTT 服务器启动失败（退出码 {status}）:\n{out}"),
                });
            }
            Ok(None) => {}
            Err(_) => break,
        }
        if waited >= 25 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        waited += 1;
    }
    *RTT_HOST.lock() = Some(host);

    // --- Client: JLinkRTTClient pipes RTT channel 0 (stdout up, stdin down) --
    let mut cc = std::process::Command::new(&client);
    cc.stdout(std::process::Stdio::piped());
    cc.stderr(std::process::Stdio::piped());
    cc.stdin(std::process::Stdio::piped());
    #[cfg(windows)]
    cc.creation_flags(CREATE_NO_WINDOW);

    let mut cclient = cc
        .spawn()
        .map_err(|e| AppError::Other(format!("启动 JLinkRTTClient 失败: {e}")))?;

    // Raw 4 KB chunk reads — RTT is NOT line-buffered — base64 → `jlink-rtt-data`.
    if let Some(out) = cclient.stdout.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::with_capacity(4096, out);
            let mut buf = vec![0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        if app2.emit("jlink-rtt-data", b64).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    if let Some(err) = cclient.stderr.take() {
        let app2 = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().flatten() {
                let _ = app2.emit("jlink-rtt-log", line);
            }
        });
    }

    // Give the client a moment to attach; if it bails immediately (could not
    // reach the RTT server), kill the host and report the failure.
    let mut waited = 0u32;
    loop {
        match cclient.try_wait() {
            Ok(Some(status)) => {
                if let Some(mut h) = RTT_HOST.lock().take() {
                    let _ = h.kill();
                    let _ = h.wait();
                }
                let _ = std::fs::remove_file(&script_path);
                let out = host_log.lock().clone();
                return Ok(JLinkResponse {
                    success: false,
                    output: format!("RTT 客户端连接失败（退出码 {status}）:\n{out}"),
                });
            }
            Ok(None) => {}
            Err(_) => break,
        }
        if waited >= 20 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        waited += 1;
    }
    *RTT_CLIENT.lock() = Some(cclient);

    Ok(JLinkResponse {
        success: true,
        output: format!("RTT 已启动（{}，端口 {RTT_SERVER_PORT}）", config.device),
    })
}

#[tauri::command]
pub async fn jlink_rtt_stop() -> AppResult<JLinkResponse> {
    let client = RTT_CLIENT.lock().take();
    let host = RTT_HOST.lock().take();
    let mut parts = Vec::new();
    if let Some(mut c) = client {
        let _ = c.kill();
        let _ = c.wait();
        parts.push("RTT 客户端已停止".to_string());
    }
    if let Some(mut h) = host {
        let _ = h.kill();
        let _ = h.wait();
        parts.push("RTT 服务器已停止".to_string());
    }
    if parts.is_empty() {
        return Ok(JLinkResponse {
            success: false,
            output: "RTT 未运行".into(),
        });
    }
    Ok(JLinkResponse {
        success: true,
        output: parts.join("\n"),
    })
}

#[tauri::command]
pub async fn jlink_rtt_running() -> bool {
    let mut h = RTT_HOST.lock();
    let alive = match h.as_mut() {
        Some(c) => {
            let alive = c.try_wait().map(|s| s.is_none()).unwrap_or(false);
            if !alive {
                *h = None; // reap dead host…
                *RTT_CLIENT.lock() = None; // …and its client pipe
            }
            alive
        }
        None => false,
    };
    alive
}

#[tauri::command]
pub async fn jlink_rtt_send(data: String) -> AppResult<JLinkResponse> {
    // Arbitrary bytes (base64) so TEXT/HEX/DEC composers all map onto the same
    // channel-0 input path.
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| AppError::Other(format!("无效的 RTT 数据（应为 base64）: {e}")))?;
    let mut c = RTT_CLIENT.lock();
    match c.as_mut() {
        Some(child) => {
            let stdin = child
                .stdin
                .as_mut()
                .ok_or_else(|| AppError::Other("RTT 客户端输入管道不可用".into()))?;
            stdin
                .write_all(&bytes)
                .and_then(|_| stdin.flush())
                .map_err(|e| AppError::Other(format!("写入 RTT 失败: {e}")))?;
            Ok(JLinkResponse {
                success: true,
                output: String::new(),
            })
        }
        None => Err(AppError::Other("RTT 客户端未运行".into())),
    }
}
