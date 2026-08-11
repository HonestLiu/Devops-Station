//! Minimal local filesystem browsing for the dual-pane SFTP tab (right pane).
//! The SFTP engine can read/write local paths for upload/download, but the app
//! had no way to enumerate the user's own directories — that's what this adds.

use std::fs;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::Serialize;

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
            if p.is_dir() {
                std::process::Command::new("explorer")
            } else {
                // `/select,` focuses the file inside an open Explorer window.
                let mut c = std::process::Command::new("explorer");
                c.arg(format!("/select,\"{}\"", path));
                c
            }
        }
        #[cfg(target_os = "macos")]
        {
            let mut c = std::process::Command::new("open");
            c.arg(path)
        }
        #[cfg(target_os = "linux")]
        {
            let mut c = std::process::Command::new("xdg-open");
            c.arg(path)
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
            // spaces.
            std::process::Command::new("cmd")
                .args(["/c", "start", "", &format!("\"{}\"", path)])
                .status()
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
