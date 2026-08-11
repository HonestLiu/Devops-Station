//! WSL (Windows Subsystem for Linux) distro discovery.
//!
//! Shells out to `wsl.exe --list --verbose` and parses the table it prints.
//! Two Windows-specific gotchas are handled here:
//!
//! 1. `wsl.exe` writes **UTF-16LE** (usually with a BOM), not UTF-8.
//! 2. Spawning a console program from a GUI process pops a black console
//!    window. Since the distro picker re-scans on a timer, that would strobe
//!    the screen — so we pass `CREATE_NO_WINDOW`.
//!
//! The `usbip` submodule implements the WSL USB Device Manager: it enumerates
//! embedded-dev USB devices via `usbipd-win`, binds+attaches them into a WSL
//! distro, and verifies/detaches them. See `usbip.rs` for the pitfall fixes
//! (timeout-guarded process calls, best-effort verify, `--distribution`
//! fallback, sticky Connected state).

pub mod device_filter;
pub mod parser;
pub mod usbip;

use serde::Serialize;
use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::process::Command;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command as TokioCommand;

use crate::error::{AppError, AppResult};
use crate::ssh::sftp::{remote_join, TransferProgress};
use crate::types::RemoteFile;

/// Windows process creation flag: run without allocating a console.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One installed WSL distribution, as reported by `wsl.exe --list --verbose`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
    /// "Running" | "Stopped" | (localized variants on non-English Windows)
    pub state: String,
    /// WSL major version — "1" or "2".
    pub version: String,
    /// True for the distro `wsl.exe` uses when no `--distribution` is given.
    pub is_default: bool,
}

/// Decode `wsl.exe` output, which is UTF-16LE on Windows.
///
/// Detection is BOM-first, with a fallback heuristic: ASCII text encoded as
/// UTF-16LE looks like `[c, 0x00, c, 0x00, …]`, so a NUL in both odd positions
/// of the first two code units is a strong signal. Anything else is treated as
/// UTF-8 so the parser still works if Microsoft ever switches encodings.
#[cfg_attr(not(windows), allow(dead_code))]
fn decode_output(bytes: &[u8]) -> String {
    let has_bom = bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE;
    let looks_utf16 = bytes.len() >= 4 && bytes[1] == 0 && bytes[3] == 0;

    if has_bom || looks_utf16 {
        let start = if has_bom { 2 } else { 0 };
        let units: Vec<u16> = bytes[start..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }

    String::from_utf8_lossy(bytes).into_owned()
}

/// Parse the `wsl --list --verbose` table.
///
/// ```text
///   NAME              STATE           VERSION
/// * Ubuntu-22.04      Running         2
///   docker-desktop    Stopped         2
/// ```
///
/// The default distro is prefixed with `*`. Distro names may contain spaces,
/// so we parse from the right: last column is VERSION, second-to-last is
/// STATE, and everything before them is the NAME.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_table(text: &str) -> Vec<WslDistro> {
    let mut out = Vec::new();

    for (idx, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
        // First non-empty line is the header row.
        if idx == 0 {
            continue;
        }

        let trimmed = line.trim();
        let is_default = trimmed.starts_with('*');
        let rest = trimmed.trim_start_matches('*').trim();

        let parts: Vec<&str> = rest.split_whitespace().collect();
        if parts.len() < 3 {
            continue;
        }

        out.push(WslDistro {
            version: parts[parts.len() - 1].to_string(),
            state: parts[parts.len() - 2].to_string(),
            name: parts[..parts.len() - 2].join(" "),
            is_default,
        });
    }

    out
}

/// List installed WSL distributions.
///
/// Returns `Ok(vec![])` when WSL runs fine but has no distros installed — the
/// UI treats that as "plug something in" guidance rather than a hard failure.
/// An `Err` means `wsl.exe` is missing or refused to run.
#[cfg(windows)]
pub fn list_distros() -> AppResult<Vec<WslDistro>> {
    let output = Command::new("wsl.exe")
        .args(["--list", "--verbose"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| {
            AppError::Other(format!(
                "Cannot run wsl.exe ({e}). Install WSL with `wsl --install` in an \
                 elevated prompt, then reopen this dialog."
            ))
        })?;

    let stdout = decode_output(&output.stdout);

    if !output.status.success() {
        let stderr = decode_output(&output.stderr);
        // "no installed distributions" is a normal empty state, not an error.
        let combined = format!("{stderr}{stdout}").to_lowercase();
        if combined.contains("no installed distributions")
            || combined.contains("has no installed")
        {
            return Ok(Vec::new());
        }
        let msg = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        return Err(AppError::Other(format!("wsl.exe failed: {msg}")));
    }

    Ok(parse_table(&stdout))
}

/// Keeps the Tauri command compiling on non-Windows dev machines.
#[cfg(not(windows))]
pub fn list_distros() -> AppResult<Vec<WslDistro>> {
    Err(AppError::Other(
        "WSL is only available on Windows.".to_string(),
    ))
}

/// Non-Windows guard used by every WSL command below.
///
/// WSL is a Windows-only feature; on macOS/Linux we return a friendly error
/// before doing any work (the Windows implementations still compile, they just
/// never run) so the UI degrades cleanly instead of trying to spawn `wsl.exe`.
#[cfg(windows)]
pub fn require_windows() -> AppResult<()> {
    Ok(())
}

#[cfg(not(windows))]
pub fn require_windows() -> AppResult<()> {
    Err(AppError::Other(
        "WSL is only available on Windows.".to_string(),
    ))
}

// ===========================================================================
// Filesystem access (mirrors `ssh::sftp` so the UI can reuse the same panel)
// ===========================================================================
//
// Each distro's filesystem is exposed to the Windows host over the
// `\\wsl$\<distro>\` UNC share, so uploads/downloads go through native file
// I/O for speed and binary safety. Listings and metadata need accurate Unix
// info (perms, owner, mtime) that the UNC layer doesn't surface, so for those
// we shell out to the distro's own `find` / `mkdir` / `rm` / `mv` instead.

const CHUNK: usize = 64 * 1024;

/// Build the Windows UNC paths for a WSL file. We try both the modern
/// `\\wsl.localhost\<distro>` prefix and the legacy `\\wsl$\<distro>` so the
/// file I/O works across Windows 10/11 regardless of which one is mounted.
fn unc_candidates(distro: &Option<String>, wsl_path: &str) -> Vec<PathBuf> {
    let distro = distro.clone().unwrap_or_default();
    let rel = wsl_path.trim_start_matches('/').replace('/', "\\");
    vec![
        PathBuf::from(format!("\\\\wsl.localhost\\{}\\{}", distro, rel)),
        PathBuf::from(format!("\\\\wsl$\\{}\\{}", distro, rel)),
    ]
}

/// Join a directory and a basename into a normalized absolute WSL path.
fn join_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// Open a WSL file for reading over the UNC share, trying each known prefix.
async fn open_unc_read(
    distro: &Option<String>,
    wsl_path: &str,
) -> AppResult<(tokio::fs::File, u64)> {
    for unc in unc_candidates(distro, wsl_path) {
        if let Ok(meta) = tokio::fs::metadata(&unc).await {
            if let Ok(f) = tokio::fs::File::open(&unc).await {
                return Ok((f, meta.len()));
            }
        }
    }
    let d = distro.clone().unwrap_or_default();
    Err(AppError::Other(format!(
        "Cannot open `{wsl_path}` in distro `{d}` over the WSL UNC share. \
         Is the distro running and the path correct?"
    )))
}

/// Create a WSL file for writing over the UNC share, trying each known prefix.
async fn open_unc_write(distro: &Option<String>, wsl_path: &str) -> AppResult<tokio::fs::File> {
    for unc in unc_candidates(distro, wsl_path) {
        if let Ok(f) = tokio::fs::File::create(&unc).await {
            return Ok(f);
        }
    }
    let d = distro.clone().unwrap_or_default();
    Err(AppError::Other(format!(
        "Cannot write to `{wsl_path}` in distro `{d}` over the WSL UNC share."
    )))
}

#[cfg(windows)]
fn spawn_wsl(distro: &str) -> TokioCommand {
    let mut cmd = TokioCommand::new("wsl.exe");
    cmd.arg("-d").arg(distro);
    // No console flash on these transient fs commands.
    cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn spawn_wsl(distro: &str) -> TokioCommand {
    let mut cmd = TokioCommand::new("wsl");
    cmd.arg("-d").arg(distro);
    cmd
}

/// Run `wsl -d <distro> <args>`; surface stderr on failure.
async fn run(distro: &str, args: &[&str]) -> AppResult<()> {
    let output = spawn_wsl(distro)
        .args(args)
        .output()
        .await
        .map_err(|e| AppError::Other(format!("wsl.exe failed: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Other(if stderr.is_empty() {
            "wsl command failed".to_string()
        } else {
            stderr
        }));
    }
    Ok(())
}

pub async fn list(distro: &Option<String>, path: &str) -> AppResult<Vec<RemoteFile>> {
    require_windows()?;
    let distro_arg = distro.clone().unwrap_or_default();
    // List from inside the distro via an explicit `sh -c` so the result is
    // deterministic and independent of the interactive login shell. `find .`
    // (relative to the target dir) emits paths as `./name`, which we then join
    // with the requested directory to build clean absolute entries — no fragile
    // prefix-stripping of the input path. The `\x1f` (unit separator) is a real
    // byte in the format string; find emits it verbatim between fields.
    let script = format!(
        "cd -- \"$1\" 2>/dev/null || exit 2; \
         find . -maxdepth 1 -mindepth 1 -printf '%y\x1f%m\x1f%s\x1f%T@\x1f%u\x1f%g\x1f%p\\n'",
    );
    let output = spawn_wsl(&distro_arg)
        .args(["-e", "sh", "-c", &script, "_", path])
        .output()
        .await
        .map_err(|e| AppError::Other(format!("wsl.exe failed: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Other(if stderr.is_empty() {
            format!(
                "Cannot list `{path}` in distro `{distro_arg}` (exit {})",
                output.status.code().unwrap_or(-1)
            )
        } else {
            stderr
        }));
    }

    let mut files: Vec<RemoteFile> = Vec::new();
    for line in output.stdout.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&[u8]> = line.split(|&b| b == 0x1f).collect();
        if parts.len() < 7 {
            continue;
        }
        let typ = parts[0];
        let mode = std::str::from_utf8(parts[1])
            .ok()
            .and_then(|s| u32::from_str_radix(s, 8).ok())
            .unwrap_or(0);
        let size = std::str::from_utf8(parts[2])
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let mtime = std::str::from_utf8(parts[3].split(|&b| b == b'.').next().unwrap_or(&[]))
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        let user = String::from_utf8_lossy(parts[4]).into_owned();
        let group = String::from_utf8_lossy(parts[5]).into_owned();
        let full = String::from_utf8_lossy(parts[6]).into_owned();

        let name = full.strip_prefix("./").unwrap_or(&full).to_string();
        let path_full = join_path(path, &name);
        let is_dir = typ == b"d";

        files.push(RemoteFile {
            path: path_full,
            name,
            is_dir,
            is_symlink: typ == b"l",
            size,
            modified: mtime,
            // Carry the type bits so this matches the SFTP convention
            // (e.g. 0o100755 regular file, 0o040755 directory).
            permissions: (if is_dir { 0o040000 } else { 0o100000 }) | mode,
            owner: Some(user),
            group: Some(group),
        });
    }

    files.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(files)
}

pub async fn home(distro: &Option<String>) -> AppResult<String> {
    require_windows()?;
    let distro_arg = distro.clone().unwrap_or_default();
    let output = spawn_wsl(&distro_arg)
        .args(["-e", "sh", "-c", "echo $HOME"])
        .output()
        .await
        .map_err(|e| AppError::Other(format!("wsl.exe failed: {e}")))?;
    let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if home.is_empty() {
        Ok("/".to_string())
    } else {
        Ok(home)
    }
}

pub async fn mkdir(distro: &Option<String>, path: &str) -> AppResult<()> {
    require_windows()?;
    let distro_arg = distro.clone().unwrap_or_default();
    run(&distro_arg, &["mkdir", "-p", path]).await
}

pub async fn remove(distro: &Option<String>, path: &str, is_dir: bool) -> AppResult<()> {
    require_windows()?;
    let distro_arg = distro.clone().unwrap_or_default();
    let args: Vec<&str> = if is_dir {
        vec!["rm", "-rf", path]
    } else {
        vec!["rm", "-f", path]
    };
    run(&distro_arg, &args).await
}

pub async fn rename(distro: &Option<String>, from: &str, to: &str) -> AppResult<()> {
    require_windows()?;
    let distro_arg = distro.clone().unwrap_or_default();
    run(&distro_arg, &["mv", "--", from, to]).await
}

fn emit_progress(
    app: &AppHandle,
    transfer_id: &str,
    file_name: &str,
    transferred: u64,
    total: u64,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        "wsl-progress",
        TransferProgress {
            transfer_id: transfer_id.to_string(),
            file_name: file_name.to_string(),
            transferred,
            total,
            done,
            error,
        },
    );
}

pub async fn download(
    app: &AppHandle,
    distro: &Option<String>,
    remote_path: &str,
    local_path: &str,
    transfer_id: &str,
) -> AppResult<()> {
    require_windows()?;
    let file_name = remote_path
        .rsplit('/')
        .next()
        .unwrap_or(remote_path)
        .to_string();
    let (mut src, total) = open_unc_read(distro, remote_path).await?;

    let mut dst = tokio::fs::File::create(local_path).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = 0;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        transferred += n as u64;
        emit_progress(app, transfer_id, &file_name, transferred, total, false, None);
    }
    dst.flush().await?;
    emit_progress(app, transfer_id, &file_name, transferred, total, true, None);
    Ok(())
}

pub async fn upload(
    app: &AppHandle,
    distro: &Option<String>,
    local_path: &str,
    remote_dir: &str,
    transfer_id: &str,
) -> AppResult<String> {
    require_windows()?;
    let file_name = Path::new(local_path)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Other(format!("invalid local path `{local_path}`")))?
        .to_string();
    let remote_path = remote_join(remote_dir, &file_name);
    let mut src = tokio::fs::File::open(local_path).await?;
    let total = src.metadata().await.map(|m| m.len()).unwrap_or(0);
    let mut dst = open_unc_write(distro, &remote_path).await?;
    let mut buf = vec![0u8; CHUNK];
    let mut transferred: u64 = 0;
    loop {
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        transferred += n as u64;
        emit_progress(app, transfer_id, &file_name, transferred, total, false, None);
    }
    dst.flush().await?;
    emit_progress(app, transfer_id, &file_name, transferred, total, true, None);
    Ok(remote_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_default_marker_and_spaced_names() {
        let table = "  NAME                   STATE           VERSION\n\
                     * Ubuntu-22.04            Running         2\n\
                       My Custom Distro        Stopped         1\n";
        let got = parse_table(table);

        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "Ubuntu-22.04");
        assert!(got[0].is_default);
        assert_eq!(got[0].state, "Running");
        assert_eq!(got[0].version, "2");
        // Names with spaces must survive: parse from the right, not the left.
        assert_eq!(got[1].name, "My Custom Distro");
        assert!(!got[1].is_default);
    }

    #[test]
    fn decodes_utf16le_with_bom() {
        let mut bytes = vec![0xFF, 0xFE];
        for ch in "NAME".encode_utf16() {
            bytes.extend_from_slice(&ch.to_le_bytes());
        }
        assert_eq!(decode_output(&bytes), "NAME");
    }

    #[test]
    fn falls_back_to_utf8() {
        assert_eq!(decode_output(b"NAME STATE"), "NAME STATE");
    }
}
