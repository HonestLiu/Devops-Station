//! USB-over-IP (`usbipd-win`) integration for the WSL USB Device Manager.
//!
//! This module wraps the `usbipd` CLI:
//! - `list`  → enumerate *embedded-dev* USB devices (filtered)
//! - `bind`  → share a device with WSL (requires administrator; auto-elevated)
//! - `attach`→ attach a (bound) device into a specific WSL distro
//! - `detach`→ return the device to Windows
//! - `verify`→ confirm the device reached WSL (`lsusb` + serial port probe)
//! - `install`→ launch the `winget` installer interactively
//!
//! **Thread-safety / responsiveness note:** every external process call goes
//! through [`run_captured`], which enforces a hard timeout and *kills* the
//! child on timeout. This is critical: `usbipd list` (and `wsl.exe`) can hang
//! on some systems (stuck device enumeration, pending UAC), and a hung process
//! that never returns would otherwise occupy a Tauri command thread forever —
//! which would also freeze unrelated commands such as `write_to_pty` (terminal
//! input). The Tauri command wrappers additionally run these on a dedicated
//! blocking pool (see `lib.rs`), so they can never starve the terminal.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;

/// Windows process creation flag: run without allocating a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use crate::wsl::device_filter;
use crate::wsl::parser::{self, Section};

/// A USB device as presented to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct UsbDevice {
    pub busid: String,
    pub vid: String,
    pub pid: String,
    /// Raw Windows device name.
    pub name: String,
    /// Friendly, human-readable name (e.g. "ESP32-S3 Dev Board").
    pub friendly_name: String,
    /// One of: "USB Serial" | "Debug Probe" | "MCU Dev Board" | "USB-JTAG".
    pub category: String,
    /// One of: "Available" | "Bound" | "Connected".
    pub status: String,
    /// Whether the device is currently attached into a WSL distro.
    pub wsl_attached: bool,
    /// Detected Linux serial ports (e.g. "/dev/ttyACM0") after attach.
    pub serial_ports: Vec<String>,
}

/// Result of verifying a device inside WSL after attach.
#[derive(Debug, Clone, Serialize, Default)]
pub struct UsbVerify {
    pub attached: bool,
    pub serial_ports: Vec<String>,
    pub lsusb: String,
    /// Optional human-readable note (e.g. a fallback explanation) for the UI.
    #[serde(default)]
    pub note: String,
}

/// Captured output of a (possibly timed-out) child process.
struct Captured {
    stdout: String,
    stderr: String,
    success: bool,
}

/// Spawn `program args`, capture stdout/stderr, and wait up to `timeout`.
///
/// On timeout the child process is *killed*, so a hung `usbipd` / `wsl.exe`
/// cannot leak a thread or a zombie process. Returns `Err` on spawn failure,
/// timeout, or child crash.
fn run_captured(program: &str, args: &[&str], timeout: Duration) -> Result<Captured, String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法运行 {program}：{e}"))?;

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{program} 无法获取 stdout"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("{program} 无法获取 stderr"))?;

    // The child handle stays in *this* scope so we can `kill()` it on timeout.
    // Only the pipes (and a result channel) move into the reader thread.
    let (tx, rx) = mpsc::channel::<(String, String)>();
    thread::spawn(move || {
        let mut out = Vec::new();
        let mut err = Vec::new();
        // Read both pipes to completion; this also unblocks the child if its
        // buffers fill up.
        let _ = stdout.read_to_end(&mut out);
        let _ = stderr.read_to_end(&mut err);
        let _ = tx.send((
            String::from_utf8_lossy(&out).to_string(),
            String::from_utf8_lossy(&err).to_string(),
        ));
    });

    match rx.recv_timeout(timeout) {
        Ok((out, err)) => {
            // Pipes closed → process is exiting; reap it here to learn the
            // exit status. `wait()` returns promptly because the process has
            // already terminated (or is about to).
            let status = child.wait().ok();
            Ok(Captured {
                stdout: out,
                stderr: err,
                success: status.map(|s| s.success()).unwrap_or(false),
            })
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "{program} 在 {:.0}s 内无响应，已强制终止（可能是 usbipd 卡住或设备枚举挂起）",
                timeout.as_secs()
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(format!("{program} 子进程异常退出")),
    }
}

/// Resolve the `usbipd` executable to invoke.
///
/// usbipd-win installs to `C:\Program Files\usbipd-win\usbipd.exe` and adds that
/// directory to PATH. A process started *before* the install (or whose PATH was
/// captured at launch) may not see `usbipd` on PATH, so we probe the well-known
/// install location first and only fall back to a bare `usbipd` (PATH lookup)
/// when that fails. This makes the feature work even when the running app was
/// launched prior to installing usbipd-win (no restart required).
fn usbipd_exe() -> String {
    const CANDIDATES: &[&str] = &[
        r"C:\Program Files\usbipd-win\usbipd.exe",
        r"C:\Program Files (x86)\usbipd-win\usbipd.exe",
    ];
    for p in CANDIDATES {
        if Path::new(p).exists() {
            return (*p).to_string();
        }
    }
    // Honor a PATH-resolved copy if present (handles non-default install dirs).
    if let Ok(c) = run_captured("where", &["usbipd"], Duration::from_secs(3)) {
        if c.success {
            let first = c.stdout.lines().next().unwrap_or("").trim();
            if !first.is_empty() {
                return first.to_string();
            }
        }
    }
    "usbipd".to_string()
}

/// Whether `usbipd-win` is installed and usable.
///
/// Uses a short timeout so a hung `usbipd --version` cannot stall the UI.
pub fn is_installed() -> bool {
    let exe = usbipd_exe();
    // Resolved a concrete path (known install dir, or a PATH copy via `where`)
    // → definitively installed.
    if exe != "usbipd" {
        return true;
    }
    // Only the bare name is available; verify it actually runs on PATH.
    if let Ok(c) = run_captured("usbipd", &["--version"], Duration::from_secs(3)) {
        if c.success {
            return true;
        }
    }
    if let Ok(c) = run_captured("where", &["usbipd"], Duration::from_secs(3)) {
        return c.success && !c.stdout.trim().is_empty();
    }
    false
}

/// Enumerate embedded-dev USB devices currently visible to Windows.
pub fn list_devices() -> Result<Vec<UsbDevice>, String> {
    let exe = usbipd_exe();
    let c = run_captured(exe.as_str(), &["list"], Duration::from_secs(12))?;
    if !c.success {
        return Err(format!("usbipd list 失败：{}", c.stderr));
    }

    let raw = parser::parse_usbipd_list(&c.stdout);

    let mut devices = Vec::new();
    for r in raw {
        // Hide consumer / internal peripherals.
        if device_filter::is_hidden(&r.vid, &r.pid, &r.device_name) {
            continue;
        }
        // Only keep recognized embedded-dev devices.
        let Some(info) = device_filter::classify(&r.vid, &r.pid, &r.device_name) else {
            continue;
        };

        let status = derive_status(&r);
        devices.push(UsbDevice {
            busid: r.busid,
            vid: r.vid,
            pid: r.pid,
            name: r.device_name,
            friendly_name: info.friendly_name,
            category: info.category.as_str().to_string(),
            status,
            wsl_attached: r.section == Section::Attached
                || r.state.as_deref() == Some("Attached"),
            serial_ports: Vec::new(),
        });
    }

    Ok(devices)
}

/// Map a parsed row to a coarse UI status.
fn derive_status(r: &parser::RawDevice) -> String {
    // An attached device is *always* "Connected", regardless of which section
    // or state column the (version-dependent) `usbipd list` output uses to
    // express it. Older usbipd-win builds list attached devices under the
    // `Connected:` header with an `Attached` state rather than a dedicated
    // `Attached:` section, so we accept both signals.
    if r.state.as_deref() == Some("Attached") {
        return "Connected".to_string();
    }
    match r.section {
        Section::Attached => "Connected".to_string(),
        Section::Shared | Section::Persisted => "Bound".to_string(),
        Section::Connected => match r.state.as_deref() {
            Some("Shared") | Some("Bind") | Some("Bound") => "Bound".to_string(),
            _ => "Available".to_string(),
        },
        Section::Unknown => "Available".to_string(),
    }
}

/// Bind (share) a device with WSL.
///
/// Binding requires administrator privileges. If the normal attempt fails with
/// an access-denied style error, we transparently retry elevated (which triggers
/// a UAC prompt).
pub fn bind(busid: &str) -> Result<(), String> {
    match try_bind(busid, false) {
        Ok(()) => Ok(()),
        Err(BindError::Failed {
            needs_admin: true, ..
        }) => try_bind(busid, true)
            .map_err(|e| format!("{e}\n（已在管理员模式下重试；若取消了 UAC 提示，请重试）")),
        Err(BindError::Failed { stderr, .. }) => Err(stderr),
        Err(BindError::Other(e)) => Err(e),
    }
}

enum BindError {
    Failed { stderr: String, needs_admin: bool },
    Other(String),
}

impl std::fmt::Display for BindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BindError::Failed { stderr, .. } => write!(f, "{stderr}"),
            BindError::Other(e) => write!(f, "{e}"),
        }
    }
}

fn try_bind(busid: &str, elevated: bool) -> Result<(), BindError> {
    if elevated {
        return run_elevated("usbipd", &["bind", "--busid", busid])
            .map_err(|e| BindError::Other(e));
    }

    let exe = usbipd_exe();
    let c = run_captured(exe.as_str(), &["bind", "--busid", busid], Duration::from_secs(60))
        .map_err(|e| BindError::Other(e))?;

    if c.success {
        Ok(())
    } else {
        let stderr = c.stderr.to_lowercase();
        let needs_admin = stderr.contains("administrator")
            || stderr.contains("elevated")
            || stderr.contains("denied")
            || stderr.contains("privilege")
            || stderr.contains("uac");
        Err(BindError::Failed {
            stderr: c.stderr,
            needs_admin,
        })
    }
}

/// Bind (if needed) and attach a device into the given WSL distro, then verify.
pub fn attach(busid: &str, distro: &str) -> Result<UsbVerify, String> {
    // `bind` is idempotent; binding an already-bound device is a no-op.
    bind(busid)?;

    // Newer usbipd-win supports `--distribution` on `attach`; older builds only
    // attach to the *default* WSL distro and reject that argument. Try the
    // precise form first, then gracefully fall back.
    let args_with_distro = ["attach", "--wsl", "--busid", busid, "--distribution", distro];
    let args_default = ["attach", "--wsl", "--busid", busid];

    let exe = usbipd_exe();
    let c = run_captured(exe.as_str(), &args_with_distro, Duration::from_secs(60))?;

    let (c, distro_note) = if !c.success && looks_like_unknown_arg(&c.stderr, "--distribution") {
        // Older usbipd-win: make the requested distro the default so the device
        // lands where the user expects, then attach to the default distro.
        let _ = run_captured("wsl.exe", &["--set-default", distro], Duration::from_secs(15));
        let c2 = run_captured(exe.as_str(), &args_default, Duration::from_secs(60))?;
        (
            c2,
            Some(format!(
                "当前 usbipd-win 版本不支持 --distribution，已临时将 {distro} 设为默认 WSL 发行版并附加到该发行版（建议升级 usbipd-win 以获得完整支持）"
            )),
        )
    } else {
        (c, None)
    };

    if !c.success {
        return Err(format!("usbipd attach 失败：{}", c.stderr));
    }

    // Attach succeeded at the OS level. Verification (lsusb / serial probe) is
    // *best-effort*: the distro may lack `lsusb`, or `wsl -d` may be slow to
    // cold-start (hitting the 15s timeout). The device is already inside WSL,
    // so never fail the whole operation on a verify error — just record what we
    // learned in `note`. This is what lets the UI show "Connected" (and thus the
    // Disconnect button) even when verification can't confirm the serial port.
    let mut verify = verify(distro).unwrap_or_else(|e| {
        let mut v = UsbVerify::default();
        v.note = format!(
            "设备已附加到 WSL，但验证未通过（{e}）；可在 WSL 中手动确认，例如 `lsusb` 或 `ls /dev/ttyACM*`"
        );
        v
    });
    verify.attached = true;
    if let Some(n) = distro_note {
        let existing = verify.note;
        verify.note = if existing.is_empty() {
            n
        } else {
            format!("{n}；{existing}")
        };
    }
    Ok(verify)
}

/// Heuristic: did usbipd reject an argument as unrecognized/unknown?
///
/// System.CommandLine emits e.g. `Unrecognized command or argument
/// '--distribution'` for unknown options; we match on the argument name so we
/// only fall back for *that* specific error, not for genuine failures.
fn looks_like_unknown_arg(stderr: &str, arg: &str) -> bool {
    let s = stderr.to_lowercase();
    (s.contains("unrecognized") && s.contains(arg)) || (s.contains("unknown") && s.contains(arg))
}

/// Detach a device, returning it to Windows.
pub fn detach(busid: &str) -> Result<(), String> {
    let exe = usbipd_exe();
    let c = run_captured(
        exe.as_str(),
        &["detach", "--busid", busid],
        Duration::from_secs(60),
    )?;
    if !c.success {
        return Err(format!("usbipd detach 失败：{}", c.stderr));
    }
    Ok(())
}

/// Verify a device reached WSL: capture `lsusb` and probe serial port nodes.
pub fn verify(distro: &str) -> Result<UsbVerify, String> {
    let mut verify = UsbVerify::default();

    if let Ok(c) = run_captured(
        "wsl.exe",
        &["-d", distro, "--", "lsusb"],
        Duration::from_secs(15),
    ) {
        if c.success {
            verify.lsusb = c.stdout.trim().to_string();
        }
    }

    if let Ok(c) = run_captured(
        "wsl.exe",
        &["-d", distro, "--", "ls", "/dev/ttyACM*", "/dev/ttyUSB*"],
        Duration::from_secs(15),
    ) {
        for line in c.stdout.lines() {
            let p = line.trim();
            if (p.starts_with("/dev/ttyACM") || p.starts_with("/dev/ttyUSB"))
                && !p.contains("No such file")
            {
                verify.serial_ports.push(p.to_string());
            }
        }
    }

    Ok(verify)
}

/// Launch the interactive `winget` installer for usbipd-win (opens a new window).
pub fn install() -> Result<(), String> {
    let c = run_captured(
        "cmd",
        &[
            "/C", "start", "", "winget", "install", "--interactive", "--exact",
            "dorssel.usbipd-win",
        ],
        Duration::from_secs(30),
    )?;
    if !c.success {
        return Err(format!("安装程序异常退出：{}", c.stderr));
    }
    Ok(())
}

/// Run a command elevated (UAC prompt) and wait for it to finish.
///
/// Uses PowerShell's `Start-Process -Verb RunAs -Wait`, which surfaces a native
/// consent prompt. A timeout bounds the wait (e.g. user ignores the UAC prompt).
fn run_elevated(program: &str, args: &[&str]) -> Result<(), String> {
    let arg_list = args
        .iter()
        .map(|a| format!("'{}'", a.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let ps = format!(
        "Start-Process -FilePath '{}' -ArgumentList @({}) -Verb RunAs -Wait",
        program, arg_list
    );

    let c = run_captured(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", &ps],
        Duration::from_secs(60),
    )?;
    if !c.success {
        return Err(format!(
            "以管理员身份运行 '{program}' 失败。若取消了 UAC 提示，请重试。\n{}",
            c.stderr
        ));
    }
    Ok(())
}
