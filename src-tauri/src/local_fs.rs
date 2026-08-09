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
