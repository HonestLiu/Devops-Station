//! Font management for the terminal.
//!
//! Two responsibilities:
//!   1. **Enumerate** every font family installed on the system (so the Settings UI can offer a
//!      searchable checklist instead of a free-text field).
//!   2. **Import** user-supplied font files (.ttf/.otf/.woff/.woff2) into the app data dir and
//!      persist them, so the frontend can register them at runtime via the CSS `FontFace` API.
//!
//! Imported fonts are tracked in a tiny `manifest.json` (`family name → file name`) so they can be
//! re-registered after a restart without re-uploading.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{AppHandle, Manager};

fn fonts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    let dir = data.join("fonts");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create fonts dir: {e}"))?;
    Ok(dir)
}

fn manifest_path(dir: &PathBuf) -> PathBuf {
    dir.join("manifest.json")
}

fn read_manifest(dir: &PathBuf) -> HashMap<String, String> {
    let p = manifest_path(dir);
    fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_manifest(dir: &PathBuf, m: &HashMap<String, String>) -> Result<(), String> {
    let s = serde_json::to_string(m).map_err(|e| e.to_string())?;
    fs::write(manifest_path(dir), s).map_err(|e| e.to_string())
}

/// Pick a container extension from the file's magic bytes (font-kit/OpenType spec).
fn guess_ext(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 4 {
        match &bytes[0..4] {
            b"\x00\x01\x00\x00" => return "ttf",
            b"OTTO" => return "otf",
            b"wOFF" => return "woff",
            b"wOF2" => return "woff2",
            b"true" | b"ttcf" => return "ttf",
            _ => {}
        }
    }
    "ttf"
}

/// Make a safe on-disk file name from an arbitrary family string.
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Enumerate every installed system font family (sorted, de-duplicated).
#[tauri::command]
pub fn list_fonts() -> Result<Vec<String>, String> {
    let families = font_kit::source::SystemSource::new()
        .all_families()
        .map_err(|e| format!("font enumeration failed: {e}"))?;
    let mut v: Vec<String> = families
        .into_iter()
        .filter(|f| !f.trim().is_empty())
        .collect();
    v.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(v)
}

/// Persist an imported font. `data` is base64 of the raw font file. Returns the family name.
#[tauri::command]
pub fn import_font(app: AppHandle, family: String, data: String) -> Result<String, String> {
    if family.trim().is_empty() {
        return Err("font family name is empty".into());
    }
    let bytes = B64.decode(&data).map_err(|e| format!("bad base64 payload: {e}"))?;
    if bytes.len() < 8 {
        return Err("font file is too small to be valid".into());
    }
    let dir = fonts_dir(&app)?;
    let mut manifest = read_manifest(&dir);
    let fname = format!("{}.{}", sanitize(&family), guess_ext(&bytes));
    fs::write(dir.join(&fname), &bytes).map_err(|e| e.to_string())?;
    manifest.insert(family.clone(), fname);
    write_manifest(&dir, &manifest)?;
    Ok(family)
}

/// List families of previously imported fonts.
#[tauri::command]
pub fn list_imported_fonts(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = fonts_dir(&app)?;
    let manifest = read_manifest(&dir);
    let mut v: Vec<String> = manifest.keys().cloned().collect();
    v.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    Ok(v)
}

/// Read an imported font back as base64 (for runtime `FontFace` registration after restart).
#[tauri::command]
pub fn read_font(app: AppHandle, family: String) -> Result<String, String> {
    let dir = fonts_dir(&app)?;
    let manifest = read_manifest(&dir);
    let fname = manifest
        .get(&family)
        .ok_or_else(|| format!("imported font '{family}' not found"))?;
    let bytes = fs::read(dir.join(fname)).map_err(|e| e.to_string())?;
    Ok(B64.encode(&bytes))
}
