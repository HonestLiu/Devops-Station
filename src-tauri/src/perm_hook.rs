//! Permission-approval HOOK bridge.
//!
//! Replaces the legacy terminal-output regex scan as the primary way Devops
//! Station learns that a vibecoding CLI (Claude Code, Codex, OpenCode, …) is
//! waiting for the user to approve an action. Instead of scanning output for
//! "approval-shaped" text (which is inherently noisy), we install a **hook into
//! the tool itself**: the tool fires the hook precisely when it needs approval,
//! and the hook forwards a small JSON payload to a local HTTP endpoint this app
//! serves (`127.0.0.1:{port}/approval`). Zero false positives by construction.
//!
//! The hooks are deliberately **notify-only and fail-open**: they POST the
//! request and immediately answer `{"continue": true}` without a decision, so
//! the agent still shows its native approval UI in the terminal. Devops
//! Station's job is to *pull the user back* (in-app bell + OS notification);
//! approving still happens in the terminal (Enter / Ctrl+Shift+Enter).
//!
//! Supported tools & config locations:
//!   - Claude Code: `~/.claude/settings.json` → `hooks.PermissionRequest`
//!   - Codex:       `~/.codex/hooks.json` + `[features] hooks = true` in
//!                  `~/.codex/config.toml`
//!   - OpenCode:    `~/.config/opencode/plugins/devops-station-approval.js`
//!                  registered in `~/.config/opencode/config.json`
//!
//! The hook scripts (Python for hooks, JS for the OpenCode plugin) are
//! generated on install and written under `~/.devops-station/hooks/`, with the
//! current listener port baked in.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::types::PermRequest;

// ---------------------------------------------------------------------------
// Script templates
// ---------------------------------------------------------------------------

/// Python hook: reads the tool's hook JSON from stdin, POSTs a notification to
/// Devops Station, and fail-opens (`{"continue": true}`) so the agent keeps its
/// native approval flow. `{port}` is replaced at install time.
const HOOK_PY: &str = r#"#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# DevOps Station approval-notify hook (installed by Devops Station settings;
# do not edit by hand). Forwards approval requests to the app; never blocks or
# decides — the agent still shows its native approval UI.
import json
import os
import sys
import time
import urllib.request

PORT = {port}

_LOG = os.path.join(os.path.expanduser("~"), ".devops-station", "hooks", "hook.log")

def _log(msg):
    try:
        with open(_LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S") + " " + msg + "\n")
    except Exception:
        pass

def main():
    raw = sys.stdin.read()
    if not raw.strip():
        return
    try:
        payload = json.loads(raw)
    except Exception:
        print(json.dumps({"continue": True}))
        return
    event = payload.get("hook_event_name", "")
    # Only the exact "needs approval" event matters; everything else passes.
    if event not in ("PermissionRequest", "PreToolUse"):
        print(json.dumps({"continue": True}))
        return
    ti = payload.get("tool_input") or {}
    if not isinstance(ti, dict):
        ti = {}
    detail = ti.get("command") or ti.get("file_path") or ti.get("path") or ""
    if not detail:
        try:
            detail = json.dumps(ti, ensure_ascii=False)[:200]
        except Exception:
            detail = ""
    body = {
        "tool": payload.get("tool_name") or "Coding Agent",
        "snippet": str(detail)[:400],
        "cwd": payload.get("cwd") or "",
        "session_id": payload.get("session_id") or payload.get("sessionId") or "",
        "event": event,
        "ts": int(time.time() * 1000),
    }
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:{port}/approval",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=2)
        _log("OK " + event + " " + str(body.get("tool")) + " " + str(detail)[:80])
    except Exception as e:
        _log("FAIL " + event + " " + str(e) + " (DevOps Station 未运行? 端口 " + str(PORT) + " 未监听?)")
    print(json.dumps({"continue": True}))
    sys.stdout.flush()

if __name__ == "__main__":
    main()
"#;

/// OpenCode plugin: listens for `permission.asked` events and forwards them to
/// the app. Does not reply, so OpenCode shows its native permission UI.
const OPENCODE_PLUGIN_JS: &str = r#"/**
 * DevOps Station approval-notify plugin (installed by Devops Station settings).
 * Forwards OpenCode permission requests to the app for notification only.
 */
export default async () => {
  const PORT = {port};
  return {
    "event": async ({ event }) => {
      try {
        const t = event.type;
        const p = event.properties || {};
        if (t === "permission.asked" && p.id) {
          const name = (p.permission || "tool");
          const toolName = name.charAt(0).toUpperCase() + name.slice(1);
          const patterns = p.patterns || [];
          let detail = "";
          if (name === "bash" && patterns.length > 0) detail = patterns.join(" && ");
          else if ((name === "edit" || name === "write") && patterns.length > 0) detail = patterns[0];
          const body = JSON.stringify({
            tool: toolName,
            snippet: detail.slice(0, 400),
            cwd: "",
            session_id: p.sessionID || "",
            event: "PermissionRequest",
            ts: Date.now(),
          });
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 2000);
            await fetch("http://127.0.0.1:{port}/approval", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body,
              signal: ctrl.signal,
            });
            clearTimeout(timer);
          } catch (e) { /* app not running — stay silent */ }
        }
      } catch (e) { /* fail open */ }
    },
  };
};
"#;

// ---------------------------------------------------------------------------
// Local HTTP listener
// ---------------------------------------------------------------------------

const MARKER: &str = "permission_notify"; // identifies *our* hook entry
const SCRIPT_NAME: &str = "permission_notify.py";
const OPENCODE_PLUGIN_NAME: &str = "devops-station-approval.js";

/// Diagnostic log for the approval server lifecycle (setup / bind / port).
/// Uses an absolute path derived from USERPROFILE/HOME (identical to the setup
/// probe) so it never depends on the process CWD.
pub fn debug_log(msg: &str) {
    let base = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    let dir = PathBuf::from(base).join(".devops-station").join("hooks");
    if let Ok(_) = std::fs::create_dir_all(&dir) {
        let path = dir.join("server.log");
        let line = format!(
            "{} {msg}\n",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );
        let _ = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .write(true)
            .open(&path)
            .map(|mut f| {
                use std::io::Write;
                let _ = f.write_all(line.as_bytes());
            });
    }
}

struct HookServerState {
    port: u16,
    thread: std::thread::JoinHandle<()>,
    shutdown: Arc<AtomicBool>,
}

static HOOK_SERVER: OnceLock<Mutex<Option<HookServerState>>> = OnceLock::new();

fn server_lock() -> &'static Mutex<Option<HookServerState>> {
    HOOK_SERVER.get_or_init(|| Mutex::new(None))
}

/// Start (or restart at a new port) the local approval endpoint. Idempotent
/// when already listening on the same port.
///
/// If binding the requested port fails (e.g. the port is taken or blocked by
/// the OS), we fall back to an OS-assigned ephemeral port and **rewrite the
/// hook scripts** with the actual port, so the hooks keep working without the
/// user having to reinstall anything.
#[tauri::command]
pub async fn perm_hook_start(app: AppHandle, port: u16) -> Result<(), String> {
    debug_log(&format!("perm_hook_start called with port={port}"));
    if port == 0 {
        return Err("端口不能为 0".to_string());
    }
    let mut guard = server_lock().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = guard.as_ref() {
        if s.port == port {
            debug_log("already listening on same port");
            return Ok(());
        }
    }
    // Port changed (or stale state): tear down the old listener first.
    if let Some(s) = guard.take() {
        s.shutdown.store(true, Ordering::Relaxed);
        let _ = s.thread.join();
    }

    let mut actual = port;
    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => l,
        Err(e) => {
            debug_log(&format!("bind {port} failed: {e}; falling back to ephemeral port"));
            let l = TcpListener::bind(("127.0.0.1", 0))
                .map_err(|e| format!("无法分配监听端口：{e}"))?;
            actual = l.local_addr().map(|a| a.port()).unwrap_or(port);
            l
        }
    };
    debug_log(&format!("bound on 127.0.0.1:{actual}"));
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置监听器失败：{e}"))?;

    // Always sync the installed hook scripts/plugins to the ACTUAL listening
    // port (idempotent). This self-heals port drift — e.g. a script that was
    // written with a stale port by an earlier run would otherwise keep POSTing
    // into a dead port while the listener listens elsewhere. Writes are
    // best-effort (a running Claude Code may transiently lock the script file;
    // the next app start will retry).
    let _ = write_hook_script(actual);
    let _ = sync_opencode_plugin(actual);
    debug_log(&format!("hook scripts synced to port {actual}"));

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown2 = shutdown.clone();
    let thread = std::thread::Builder::new()
        .name("perm-hook-server".into())
        .spawn(move || serve(app, listener, shutdown2))
        .map_err(|e| format!("启动审批服务失败：{e}"))?;

    *guard = Some(HookServerState { port: actual, thread, shutdown });
    debug_log(&format!("listener started on {actual}"));
    Ok(())
}

/// Stop the local approval endpoint.
#[tauri::command]
pub async fn perm_hook_stop() -> Result<(), String> {
    let mut guard = server_lock().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = guard.take() {
        s.shutdown.store(true, Ordering::Relaxed);
        let _ = s.thread.join();
    }
    Ok(())
}

fn serve(app: AppHandle, listener: TcpListener, shutdown: Arc<AtomicBool>) {
    while !shutdown.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => handle_conn(app.clone(), stream),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
}

/// Minimal HTTP/1.1 handler: accepts `POST /approval` with a JSON body,
/// emits a `perm-request` event (source = "hook") and raises the OS
/// notification. Anything else gets 404.
fn handle_conn(app: AppHandle, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let mut buf = [0u8; 16384];
    let mut read = 0usize;
    while read < buf.len() {
        match stream.read(&mut buf[read..]) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                read += n;
                if buf[..read].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
        }
    }
    let Some(head_end) = buf[..read].windows(4).position(|w| w == b"\r\n\r\n") else {
        return;
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let req_line = lines.next().unwrap_or("");
    let content_length = lines
        .filter_map(|l| {
            let mut it = l.splitn(2, ':');
            let k = it.next()?.trim().to_ascii_lowercase();
            let v = it.next()?.trim();
            (k == "content-length").then(|| v.parse::<usize>().ok()).flatten()
        })
        .next()
        .unwrap_or(0);
    let path = req_line.split_whitespace().nth(1).unwrap_or("");
    let body_start = head_end + 4;
    let body = if read >= body_start + content_length {
        String::from_utf8_lossy(&buf[body_start..body_start + content_length]).to_string()
    } else {
        String::new()
    };

    let mut status_line = "HTTP/1.1 404 Not Found";
    let mut body_out: &[u8] = b"";
    if path == "/approval" && !body.trim().is_empty() {
        if let Ok(v) = serde_json::from_str::<Value>(&body) {
            let tool = v
                .get("tool")
                .and_then(|x| x.as_str())
                .unwrap_or("Coding Agent")
                .to_string();
            let snippet = v.get("snippet").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let session_id = v
                .get("session_id")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let ts = v
                .get("ts")
                .and_then(|x| x.as_u64())
                .unwrap_or_else(|| {
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0)
                });
            let payload = PermRequest {
                session_id,
                tool: tool.clone(),
                snippet: snippet.clone(),
                ts,
                source: "hook".to_string(),
            };
            // In-app bell entry. Log the outcome so a "toast OK but bell empty"
            // report can be diagnosed from server.log instead of guessed at.
            match app.emit("perm-request", &payload) {
                Ok(()) => debug_log(&format!(
                    "POST /approval tool={tool} -> perm-request emitted (snippet: {})",
                    snippet.chars().take(60).collect::<String>()
                )),
                Err(e) => debug_log(&format!(
                    "POST /approval tool={tool} -> perm-request emit FAILED: {e}"
                )),
            }
            // OS notification (same switch as the scan path).
            if crate::perm::approval_notifications_enabled() {
                let app2 = app.clone();
                let tool2 = tool.clone();
                let snippet2 = snippet.clone();
                std::thread::spawn(move || {
                    let lines: Vec<&str> = snippet2.lines().collect();
                    let body = if lines.len() > 3 {
                        format!("{}\n…", lines[..3].join("\n"))
                    } else {
                        snippet2
                    };
                    crate::notify::show(&app2, &format!("Approval needed · {tool2}"), &body);
                });
            }
            status_line = "HTTP/1.1 200 OK";
            body_out = b"OK";
        }
    }
    let resp = format!(
        "{status_line}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body_out.len()
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.write_all(body_out);
}

// ---------------------------------------------------------------------------
// Install / uninstall / status
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    /// Whether our hook is currently installed for this tool.
    pub installed: bool,
    /// Whether the tool's config file exists at all (tool appears present).
    pub tool_detected: bool,
    /// The config path we would manage.
    pub config_path: String,
}

#[tauri::command]
pub async fn perm_hook_install(tool: String, port: u16) -> Result<String, String> {
    match tool.as_str() {
        "claude" => install_claude(port),
        "codex" => install_codex(port),
        "opencode" => install_opencode(port),
        other => Err(format!("未知工具：{other}")),
    }
}

#[tauri::command]
pub async fn perm_hook_uninstall(tool: String) -> Result<String, String> {
    match tool.as_str() {
        "claude" => uninstall_claude(),
        "codex" => uninstall_codex(),
        "opencode" => uninstall_opencode(),
        other => Err(format!("未知工具：{other}")),
    }
}

#[tauri::command]
pub async fn perm_hook_status(tool: String) -> Result<HookStatus, String> {
    Ok(match tool.as_str() {
        "claude" => status_claude(),
        "codex" => status_codex(),
        "opencode" => status_opencode(),
        other => {
            return Err(format!("未知工具：{other}"));
        }
    })
}

// --- path helpers -----------------------------------------------------------

fn home_dir() -> PathBuf {
    if let Ok(h) = std::env::var("USERPROFILE") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            return PathBuf::from(h);
        }
    }
    PathBuf::from(".")
}

fn hooks_dir() -> PathBuf {
    home_dir().join(".devops-station").join("hooks")
}

/// Detect a usable Python interpreter for the hook command.
fn python_cmd() -> Option<String> {
    for c in ["python", "python3", "py"] {
        if Command::new(c)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return Some(c.to_string());
        }
    }
    None
}

/// Write the Python hook script (with the current port baked in) and return
/// the shell command that runs it.
fn write_hook_script(port: u16) -> Result<String, String> {
    let dir = hooks_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 HOOK 目录失败：{e}"))?;
    let path = dir.join(SCRIPT_NAME);
    let script = HOOK_PY.replace("{port}", &port.to_string());
    std::fs::write(&path, script).map_err(|e| format!("写入 HOOK 脚本失败：{e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
    }
    let py = python_cmd().ok_or_else(|| {
        "未检测到 Python 解释器（python / python3 / py）。请先安装 Python 3。".to_string()
    })?;
    let script_path = path.to_string_lossy().replace('\\', "/");
    Ok(format!("{py} \"{script_path}\""))
}

// --- JSON helpers -----------------------------------------------------------

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("解析 {} 失败：{e}", path.display()))
}

fn write_json(path: &Path, v: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(v).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(path, format!("{text}\n")).map_err(|e| format!("写入 {} 失败：{e}", path.display()))
}

/// Get-or-insert an object field (avoids double mutable borrows).
fn ensure_obj<'a>(root: &'a mut Value, key: &str) -> &'a mut Value {
    if root.get(key).is_none() {
        root[key] = json!({});
    }
    root.get_mut(key).expect("ensure_obj: key just inserted")
}

/// Get-or-insert an array field.
fn ensure_arr<'a>(root: &'a mut Value, key: &str) -> &'a mut Value {
    if root.get(key).is_none() {
        root[key] = json!([]);
    }
    root.get_mut(key).expect("ensure_arr: key just inserted")
}

fn has_our_command(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hs| {
            hs.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn remove_our_hooks(events: &mut Value, event_name: &str) -> bool {
    let Some(arr) = events.get_mut(event_name).and_then(|v| v.as_array_mut()) else {
        return false;
    };
    // Drop whole matcher groups that only contain our hook; strip our hook out
    // of groups that also carry foreign hooks.
    arr.retain(|g| !has_our_command(g) || !g.get("hooks").and_then(|h| h.as_array()).map(|hs| hs.len() == 1).unwrap_or(true));
    for g in arr.iter_mut() {
        if let Some(hs) = g.get_mut("hooks").and_then(|v| v.as_array_mut()) {
            hs.retain(|h| {
                !h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(MARKER))
                    .unwrap_or(false)
            });
        }
    }
    true
}

// --- Claude Code ------------------------------------------------------------

fn claude_settings_path() -> PathBuf {
    home_dir().join(".claude").join("settings.json")
}

fn install_claude(port: u16) -> Result<String, String> {
    let cfg = claude_settings_path();
    if !cfg.exists() {
        return Err("未检测到 Claude Code 配置（~/.claude/settings.json）。请先安装并至少运行一次 Claude Code。".to_string());
    }
    let cmd = write_hook_script(port)?;
    let mut settings = read_json(&cfg)?;
    // Drop any previous install of ours first (borrow ends before re-acquire).
    if let Some(hooks) = settings.get_mut("hooks") {
        remove_our_hooks(hooks, "PermissionRequest");
    }
    let hooks = ensure_obj(&mut settings, "hooks");
    let perm = ensure_arr(hooks, "PermissionRequest");
    let already = perm
        .as_array()
        .map(|arr| arr.iter().any(has_our_command))
        .unwrap_or(false);
    if !already {
        perm.as_array_mut()
            .ok_or_else(|| "hooks.PermissionRequest 格式异常".to_string())?
            .push(json!({ "matcher": "", "hooks": [{ "type": "command", "command": cmd }] }));
    }
    write_json(&cfg, &settings)?;
    Ok(format!("已为 Claude Code 安装审批 HOOK（{}）", cfg.display()))
}

fn uninstall_claude() -> Result<String, String> {
    let cfg = claude_settings_path();
    if !cfg.exists() {
        return Ok("Claude Code 配置不存在，无需卸载。".to_string());
    }
    let mut settings = read_json(&cfg)?;
    if let Some(hooks) = settings.get_mut("hooks") {
        remove_our_hooks(hooks, "PermissionRequest");
        // Drop empty PermissionRequest arrays so we never leave junk behind.
        if hooks
            .get("PermissionRequest")
            .and_then(|v| v.as_array())
            .map(|a| a.is_empty())
            .unwrap_or(false)
        {
            hooks.as_object_mut().map(|m| m.remove("PermissionRequest"));
        }
        write_json(&cfg, &settings)?;
    }
    maybe_cleanup_hook_script();
    Ok(format!("已移除 Claude Code 审批 HOOK（{}）", cfg.display()))
}

fn status_claude() -> HookStatus {
    let cfg = claude_settings_path();
    let installed = cfg.exists()
        && read_json(&cfg)
            .ok()
            .and_then(|s| s.get("hooks").cloned())
            .map(|h| {
                h.get("PermissionRequest")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().any(has_our_command))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
    HookStatus {
        installed,
        tool_detected: cfg.exists(),
        config_path: cfg.display().to_string(),
    }
}

// --- Codex ------------------------------------------------------------------

fn codex_dir() -> PathBuf {
    home_dir().join(".codex")
}
fn codex_hooks_path() -> PathBuf {
    codex_dir().join("hooks.json")
}
fn codex_toml_path() -> PathBuf {
    codex_dir().join("config.toml")
}

fn install_codex(port: u16) -> Result<String, String> {
    let dir = codex_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 Codex 配置目录失败：{e}"))?;
    let cmd = write_hook_script(port)?;

    let hooks_file = codex_hooks_path();
    let mut hooks = if hooks_file.exists() {
        read_json(&hooks_file)?
    } else {
        json!({})
    };
    // Drop any previous install of ours first.
    if let Some(h) = hooks.get_mut("hooks") {
        remove_our_hooks(h, "PermissionRequest");
    }
    let h = ensure_obj(&mut hooks, "hooks");
    let perm = ensure_arr(h, "PermissionRequest");
    let already = perm
        .as_array()
        .map(|arr| arr.iter().any(has_our_command))
        .unwrap_or(false);
    if !already {
        perm.as_array_mut()
            .ok_or_else(|| "hooks.PermissionRequest 格式异常".to_string())?
            .push(json!({ "matcher": "", "hooks": [{ "type": "command", "command": cmd, "timeout": 5 }] }));
    }
    write_json(&hooks_file, &hooks)?;

    // config.toml: make sure [features] hooks = true (or legacy codex_hooks).
    ensure_codex_hooks_enabled()?;
    Ok(format!("已为 Codex 安装审批 HOOK（{}）", hooks_file.display()))
}

fn ensure_codex_hooks_enabled() -> Result<(), String> {
    let toml = codex_toml_path();
    let text = if toml.exists() {
        std::fs::read_to_string(&toml).map_err(|e| format!("读取 {} 失败：{e}", toml.display()))?
    } else {
        String::new()
    };
    if text.contains("codex_hooks = true") || text.contains("hooks = true") {
        // Already enabled (new key "hooks" wins; legacy key also fine).
        return Ok(());
    }
    let next: String = if text.contains("[features]") {
        // Insert `hooks = true` right after the [features] header line.
        let marker = "[features]";
        if let Some(pos) = text.find(marker) {
            let line_end = text[pos..].find('\n').map(|i| pos + i + 1).unwrap_or(text.len());
            format!("{}\nhooks = true{}", &text[..line_end], &text[line_end..])
        } else {
            format!("{text}\n[features]\nhooks = true\n")
        }
    } else {
        format!("{text}\n[features]\nhooks = true\n")
    };
    std::fs::write(&toml, format!("{next}\n")).map_err(|e| format!("写入 {} 失败：{e}", toml.display()))
}

fn uninstall_codex() -> Result<String, String> {
    let hooks_file = codex_hooks_path();
    if hooks_file.exists() {
        let mut hooks = read_json(&hooks_file)?;
        if let Some(h) = hooks.get_mut("hooks") {
            remove_our_hooks(h, "PermissionRequest");
            if h
                .get("PermissionRequest")
                .and_then(|v| v.as_array())
                .map(|a| a.is_empty())
                .unwrap_or(false)
            {
                h.as_object_mut().map(|m| m.remove("PermissionRequest"));
            }
            write_json(&hooks_file, &hooks)?;
        }
    }
    maybe_cleanup_hook_script();
    Ok(format!("已移除 Codex 审批 HOOK（{}）", hooks_file.display()))
}

fn status_codex() -> HookStatus {
    let hooks_file = codex_hooks_path();
    let installed = hooks_file.exists()
        && read_json(&hooks_file)
            .ok()
            .and_then(|s| s.get("hooks").cloned())
            .map(|h| {
                h.get("PermissionRequest")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().any(has_our_command))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
    HookStatus {
        installed,
        tool_detected: hooks_file.exists() || codex_toml_path().exists(),
        config_path: hooks_file.display().to_string(),
    }
}

// --- OpenCode ---------------------------------------------------------------

fn opencode_plugins_dir() -> PathBuf {
    home_dir().join(".config").join("opencode").join("plugins")
}
fn opencode_config_path() -> PathBuf {
    home_dir().join(".config").join("opencode").join("config.json")
}
fn opencode_plugin_path() -> PathBuf {
    opencode_plugins_dir().join(OPENCODE_PLUGIN_NAME)
}

/// Write the OpenCode plugin JS (with the current port baked in). Always
/// writes — this is the *install* step, so the file must be created even when
/// it does not exist yet. (The old behaviour no-op'd when the file was missing,
/// which meant a first-time install wrote the config.json reference but never
/// created the plugin file — status then reported "not installed" and OpenCode
/// never loaded the plugin.)
fn write_opencode_plugin(port: u16) -> Result<(), String> {
    let plugin = opencode_plugin_path();
    if let Some(parent) = plugin.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 OpenCode 插件目录失败：{e}"))?;
    }
    let js = OPENCODE_PLUGIN_JS.replace("{port}", &port.to_string());
    std::fs::write(&plugin, js).map_err(|e| format!("写入 OpenCode 插件失败：{e}"))
}

/// Re-sync the port inside an *already installed* OpenCode plugin. No-op unless
/// the plugin file exists **or** `~/.config/opencode/config.json` still
/// references it — the latter self-heals the broken state where a stale install
/// left the config entry behind without the plugin file.
fn sync_opencode_plugin(port: u16) -> Result<(), String> {
    let plugin = opencode_plugin_path();
    let referenced = opencode_config_path()
        .exists()
        .then(|| read_json(&opencode_config_path()).ok())
        .flatten()
        .map(|c| {
            c.get("plugin")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    let reference =
                        format!("file://{}", plugin.to_string_lossy().replace('\\', "/"));
                    arr.iter()
                        .any(|p| p.as_str() == Some(reference.as_str()))
                })
                .unwrap_or(false)
        })
        .unwrap_or(false);
    if !plugin.exists() && !referenced {
        return Ok(());
    }
    write_opencode_plugin(port)
}

fn install_opencode(port: u16) -> Result<String, String> {
    let dir = opencode_plugins_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 OpenCode 插件目录失败：{e}"))?;
    write_opencode_plugin(port)?;
    let plugin = opencode_plugin_path();

    let cfg = opencode_config_path();
    let mut config = if cfg.exists() {
        read_json(&cfg)?
    } else {
        json!({})
    };
    let plugins = ensure_arr(&mut config, "plugin");
    let reference = format!("file://{}", plugin.to_string_lossy().replace('\\', "/"));
    let arr = plugins.as_array_mut().ok_or_else(|| "config.json plugin 格式异常".to_string())?;
    if !arr.iter().any(|p| p.as_str().map(|s| s == reference).unwrap_or(false)) {
        arr.push(json!(reference));
    }
    write_json(&cfg, &config)?;
    Ok(format!("已为 OpenCode 安装审批插件（{}）", plugin.display()))
}

fn uninstall_opencode() -> Result<String, String> {
    let plugin = opencode_plugin_path();
    if plugin.exists() {
        let _ = std::fs::remove_file(&plugin);
    }
    let cfg = opencode_config_path();
    if cfg.exists() {
        let mut config = read_json(&cfg)?;
        if let Some(plugins) = config.get_mut("plugin").and_then(|v| v.as_array_mut()) {
            let reference = format!("file://{}", plugin.to_string_lossy().replace('\\', "/"));
            plugins.retain(|p| p.as_str().map(|s| s != reference).unwrap_or(true));
            write_json(&cfg, &config)?;
        }
    }
    maybe_cleanup_hook_script();
    Ok("已移除 OpenCode 审批插件。".to_string())
}

/// True while any of the three tools still references our hook (script must stay).
fn hook_script_referenced() -> bool {
    let claude = claude_settings_path();
    if claude.exists() {
        if let Ok(v) = read_json(&claude) {
            if let Some(h) = v.get("hooks") {
                if h.get("PermissionRequest")
                    .and_then(|a| a.as_array())
                    .map(|arr| arr.iter().any(has_our_command))
                    .unwrap_or(false)
                {
                    return true;
                }
            }
        }
    }
    let codex = codex_hooks_path();
    if codex.exists() {
        if let Ok(v) = read_json(&codex) {
            if let Some(h) = v.get("hooks") {
                if h.get("PermissionRequest")
                    .and_then(|a| a.as_array())
                    .map(|arr| arr.iter().any(has_our_command))
                    .unwrap_or(false)
                {
                    return true;
                }
            }
        }
    }
    opencode_plugin_path().exists()
}

/// Remove the generated hook script (and empty hooks dir) once no tool
/// references it any more — uninstalling the last tool should leave nothing.
fn maybe_cleanup_hook_script() {
    if hook_script_referenced() {
        return;
    }
    let dir = hooks_dir();
    let script = dir.join(SCRIPT_NAME);
    if script.exists() {
        let _ = std::fs::remove_file(&script);
    }
    let _ = std::fs::remove_dir(&dir);
}

fn status_opencode() -> HookStatus {
    let plugin = opencode_plugin_path();
    HookStatus {
        installed: plugin.exists(),
        tool_detected: opencode_plugins_dir().exists() || opencode_config_path().exists(),
        config_path: plugin.display().to_string(),
    }
}
