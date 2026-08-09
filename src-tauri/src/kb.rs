//! Local knowledge-base scanning for the AI "knowledge base" feature.
//!
//! The frontend drives retrieval (chunk + keyword index), but it cannot read the
//! user's filesystem directly, so it asks the backend to enumerate and read text
//! files under a chosen root directory. We deliberately keep this dependency-free
//! (std::fs only) — no embeddings, no external services.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KBFile {
    pub path: String,
    pub name: String,
    pub content: String,
}

/// Extensions we treat as readable text for the knowledge base.
const TEXT_EXTS: &[&str] = &[
    "md", "markdown", "txt", "text", "log", "csv", "json", "yaml", "yml", "toml", "ini", "rst",
    "adoc",
];

const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_FILES: usize = 300;
/// Skip these directory names entirely (large, usually irrelevant).
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    "venv",
    "__pycache__",
];

fn is_text_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| TEXT_EXTS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

#[tauri::command]
pub fn kb_scan(root: String) -> Result<Vec<KBFile>, String> {
    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("Path does not exist: {root}"));
    }

    let mut out: Vec<KBFile> = Vec::new();
    scan_dir(root_path, &mut out)?;
    Ok(out)
}

fn scan_dir(dir: &Path, out: &mut Vec<KBFile>) -> Result<(), String> {
    if out.len() >= MAX_FILES {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries {
        if out.len() >= MAX_FILES {
            break;
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let ftype = entry
            .file_type()
            .map_err(|e| format!("{}: {e}", path.display()))?;

        if ftype.is_dir() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            if SKIP_DIRS.contains(&name) {
                continue;
            }
            scan_dir(&path, out)?;
        } else if ftype.is_file() && is_text_ext(&path) {
            match read_text_file(&path) {
                Some(content) if !content.trim().is_empty() => {
                    out.push(KBFile {
                        path: path.to_string_lossy().to_string(),
                        name: path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or_default()
                            .to_string(),
                        content,
                    });
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn read_text_file(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() as usize > MAX_FILE_BYTES {
        // Truncate large files to keep memory/prompt size bounded.
        let mut handle = fs::File::open(path).ok()?;
        use std::io::Read;
        let mut buf = vec![0u8; MAX_FILE_BYTES];
        let n = handle.read(&mut buf).ok()?;
        buf.truncate(n);
        String::from_utf8_lossy(&buf).into_owned().into()
    } else {
        fs::read_to_string(path).ok()
    }
}

#[tauri::command]
pub fn kb_read(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}
