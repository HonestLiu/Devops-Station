//! Minimal local filesystem browsing for the dual-pane SFTP tab (right pane).
//! The SFTP engine can read/write local paths for upload/download, but the app
//! had no way to enumerate the user's own directories — that's what this adds.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use serde::Serialize;

/// Windows process creation flag: run without allocating a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Modification time as Unix seconds (0 if unavailable).
    pub modified: i64,
}

#[tauri::command]
pub fn local_home() -> Result<String, String> {
    for var in ["USERPROFILE", "HOME"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                return Ok(v);
            }
        }
    }
    Err("cannot resolve the user home directory".to_string())
}

#[tauri::command]
pub fn local_list(path: String) -> Result<Vec<LocalEntry>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    let mut out: Vec<LocalEntry> = Vec::new();
    let entries = fs::read_dir(root).map_err(|e| format!("{path}: {e}"))?;
    for entry in entries.flatten() {
        let ftype = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().ok();
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        out.push(LocalEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: ftype.is_dir(),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified,
        });
    }

    // Directories first, then by name (case-insensitive).
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Open the OS file manager at `path`, selecting the file when it is a regular
/// file (so the user lands on it instead of just the containing folder). Used by
/// the Local Shell's directory-navigation bar ("Open in Explorer/Finder").
#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {path}"));
    }

    let mut cmd = {
        #[cfg(target_os = "windows")]
        {
            // Normalize before launching Explorer:
            //  - a trailing separator is parsed as escaping the closing quote
            //    (e.g. `explorer "C:\dir\"`), which makes it open a new window at
            //    the default location instead of the folder we asked for;
            //  - forward slashes confuse the shell, so force backslashes.
            let norm = path.trim_end_matches(['\\', '/']).replace('/', "\\");
            if p.is_dir() {
                // Launch the file manager directly on the directory.
                let mut c = std::process::Command::new("explorer.exe");
                c.arg(norm);
                c
            } else {
                // `/select,` focuses the file inside an open Explorer window.
                let mut c = std::process::Command::new("explorer.exe");
                c.arg(format!("/select,\"{}\"", norm));
                c
            }
        }
        #[cfg(target_os = "macos")]
        {
            let norm = path.trim_end_matches('/');
            let mut c = std::process::Command::new("open");
            c.arg(norm);
            c
        }
        #[cfg(target_os = "linux")]
        {
            let norm = path.trim_end_matches('/');
            let mut c = std::process::Command::new("xdg-open");
            c.arg(norm);
            c
        }
    };

    let status = cmd
        .status()
        .map_err(|e| format!("failed to launch file manager: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("file manager exited with status {status}"))
    }
}

/// Open `path` in the OS-assigned default application (not just the file manager).
/// Used by the Files sidebar's "Open" action. Differs from `reveal_path`, which
/// navigates the file manager and (for files) selects rather than opens.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("path does not exist: {path}"));
    }

    let status = {
        #[cfg(target_os = "windows")]
        {
            // `start` opens the file with its default association. The empty ""
            // is the required window-title placeholder; the quoted path survives
            // spaces. CREATE_NO_WINDOW suppresses the cmd.exe console flash.
            let mut c = std::process::Command::new("cmd");
            c.args(["/c", "start", "", &format!("\"{}\"", path)]);
            #[cfg(windows)]
            c.creation_flags(CREATE_NO_WINDOW);
            c.status()
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(path).status()
        }
        #[cfg(target_os = "linux")]
        {
            std::process::Command::new("xdg-open").arg(path).status()
        }
    }
    .map_err(|e| format!("failed to open file: {e}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("failed to open (exit status {status})"))
    }
}

/// Open a URL in the user's default browser.
///
/// Used by terminal link clicks (Ctrl/Cmd+click) and AI-rendered markdown
/// links. Only `http://` / `https://` is accepted — the OS "open" verbs would
/// otherwise hand arbitrary URIs (and their embedded arguments) straight to
/// the shell.
///
/// Uses the `opener` crate instead of raw `cmd /c start` / `xdg-open` / `open`
/// so quoting and trailing punctuation (e.g. a terminal-printed `http://x/\`)
/// are handled correctly.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    // Terminal emulators sometimes include a trailing backslash or carriage
    // return as part of the linkified text. Strip those before handing the
    // URL to the OS so it is not mistaken for a local file path.
    let url = url.trim().trim_end_matches(&['\\', '\r', '\n'][..]);
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("only http/https URLs can be opened externally".to_string());
    }

    opener::open_browser(url).map_err(|e| format!("failed to open URL: {e}"))
}

/// Create a directory (and any missing parents). Backs the Local file panel's
/// "New folder" action, mirroring the SFTP/WSL panels.
#[tauri::command]
pub fn local_mkdir(path: String) -> Result<(), String> {
    fs::create_dir_all(Path::new(&path)).map_err(|e| format!("cannot create directory {path}: {e}"))
}

/// Remove a file, or a directory and everything under it. Backs the Local file
/// panel's "Delete" action (dirs are removed recursively, like SFTP/WSL).
#[tauri::command]
pub fn local_remove(path: String, is_dir: bool) -> Result<(), String> {
    let p = Path::new(&path);
    let res = if is_dir {
        fs::remove_dir_all(p)
    } else {
        fs::remove_file(p)
    };
    res.map_err(|e| format!("cannot remove {path}: {e}"))
}

/// Rename / move a local file or directory. Backs the Local file panel's
/// "Rename" action.
#[tauri::command]
pub fn local_rename(from: String, to: String) -> Result<(), String> {
    fs::rename(Path::new(&from), Path::new(&to))
        .map_err(|e| format!("cannot rename {from} -> {to}: {e}"))
}

/// Write text content to an arbitrary local path. Used by exporters (protocol
/// project JSON, C project, …) so the user can pick a target directory + file
/// name via the native save dialog instead of a browser download.
#[tauri::command]
pub fn local_write_text(path: String, content: String) -> Result<(), String> {
    fs::write(Path::new(&path), content).map_err(|e| format!("cannot write {path}: {e}"))
}
