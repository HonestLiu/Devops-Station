//! Local shell sessions via a native PTY (ConPTY on Windows, openpty elsewhere).
//!
//! Gives the app a "local terminal" tab so you don't have to leave it to run
//! `git`, `ping`, or a flashing tool while debugging a board.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::stream::{Attached, OutputBuffer};
use crate::types::{SessionClosed, StreamChunk};

pub fn data_event(session_id: &str) -> String {
    format!("pty-data-{session_id}")
}
pub fn closed_event(session_id: &str) -> String {
    format!("pty-closed-{session_id}")
}

pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    output: Arc<OutputBuffer>,
}

impl PtySession {
    /// Hand the UI everything the shell printed before it could listen.
    pub fn attach(&self) -> Attached {
        self.output.attach()
    }

    pub fn write(&self, bytes: &[u8]) -> AppResult<()> {
        let mut w = self.writer.lock();
        w.write_all(bytes)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> AppResult<()> {
        self.master
            .lock()
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Other(format!("pty resize failed: {e}")))
    }

    pub fn kill(&self) {
        let _ = self.child.lock().kill();
    }
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
}

impl PtyManager {
    pub fn get(&self, id: &str) -> AppResult<Arc<PtySession>> {
        self.sessions
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))
    }

    pub fn close(&self, id: &str) -> AppResult<()> {
        if let Some(s) = self.sessions.lock().remove(id) {
            s.kill();
        }
        Ok(())
    }

    pub fn close_all(&self) {
        for (_, s) in self.sessions.lock().drain() {
            s.kill();
        }
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    ) -> AppResult<String> {
        let shell = shell.unwrap_or_else(default_shell);
        let mut cmd = CommandBuilder::new(shell.clone());
        // On Unix, launch the shell as a *login* shell (`-l`) so it sources the
        // user's profile (`/etc/profile`, `~/.zprofile`, `/etc/zprofile` →
        // `path_helper` → `/etc/paths` + `/etc/paths.d`, which is where Homebrew
        // registers `/opt/homebrew/bin` / `/usr/local/bin`). A Tauri GUI app does
        // NOT inherit the login environment, so a bare (non-login) shell starts
        // with a minimal PATH and `brew`, `node`, etc. are suddenly "not found"
        // even though they work in the system Terminal. Windows shells (pwsh /
        // powershell / cmd) don't take `-l`, so only add it off-Windows and only
        // for shells that understand it.
        #[cfg(not(windows))]
        {
            let base = shell.rsplit('/').next().unwrap_or(&shell);
            if ["bash", "zsh", "sh", "ksh", "fish", "tcsh", "csh", "dash"]
                .iter()
                .any(|s| *s == base)
            {
                cmd.arg("-l");
            }
        }
        if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
            cmd.cwd(dir);
        }
        cmd.env("TERM", "xterm-256color");

        self.launch(app, cmd, cols, rows, "shell exited")
    }

    /// Start a shell inside a WSL distribution.
    ///
    /// Runs through the same ConPTY plumbing as a local shell — `wsl.exe` is
    /// just the program we launch — so resize, attach-backlog and teardown all
    /// behave identically.
    ///
    /// `cwd` maps to `wsl --cd`, which needs Windows build 21354 or newer. On
    /// older builds `wsl.exe` prints an error and exits; that text lands in the
    /// terminal so the failure is visible rather than silent.
    pub fn spawn_wsl(
        &self,
        app: AppHandle,
        distro: Option<String>,
        user: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    ) -> AppResult<String> {
        // WSL is a Windows-only feature; fail fast with a friendly message
        // instead of trying to spawn a nonexistent `wsl.exe`.
        crate::wsl::require_windows()?;
        let mut cmd = CommandBuilder::new("wsl.exe");

        // No --distribution means "use whatever WSL considers the default".
        if let Some(d) = distro.filter(|s| !s.trim().is_empty()) {
            cmd.arg("--distribution");
            cmd.arg(d.trim());
        }
        if let Some(u) = user.filter(|s| !s.trim().is_empty()) {
            cmd.arg("--user");
            cmd.arg(u.trim());
        }
        if let Some(dir) = cwd.filter(|s| !s.trim().is_empty()) {
            cmd.arg("--cd");
            cmd.arg(dir.trim());
        }

        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");

        self.launch(app, cmd, cols, rows, "wsl session ended")
    }

    /// Start an `frpc` reverse-proxy tunnel.
    ///
    /// `frpc_bin` is the absolute path to the `frpc` executable (resolved by
    /// the caller via `frp::locate_frpc`) and `config_path` points at the
    /// generated `frpc.toml`. Like WSL, frpc is just a program on the PTY, so
    /// resize / attach-backlog / teardown behave like a local shell.
    pub fn spawn_frp(
        &self,
        app: AppHandle,
        frpc_bin: String,
        config_path: String,
        cols: u16,
        rows: u16,
    ) -> AppResult<String> {
        let mut cmd = CommandBuilder::new(frpc_bin);
        cmd.arg("-c");
        cmd.arg(config_path);
        cmd.env("TERM", "xterm-256color");

        self.launch(app, cmd, cols, rows, "frp tunnel closed")
    }

    /// Shared plumbing: open a PTY, spawn `cmd` on the slave end, and pump the
    /// master through an [`OutputBuffer`] so nothing printed before the UI
    /// attaches gets dropped.
    fn launch(
        &self,
        app: AppHandle,
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        exit_reason: &'static str,
    ) -> AppResult<String> {
        let session_id = uuid::Uuid::new_v4().to_string();

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Other(format!("cannot open pty: {e}")))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Other(format!("cannot spawn shell: {e}")))?;
        // Dropping the slave lets the child own the only handle, so the reader
        // gets EOF when the shell exits instead of hanging forever.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Other(format!("cannot read pty: {e}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Other(format!("cannot write pty: {e}")))?;

        let output = Arc::new(OutputBuffer::new());
        let session = Arc::new(PtySession {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            output: output.clone(),
        });
        self.sessions
            .lock()
            .insert(session_id.clone(), session.clone());

        let sid = session_id.clone();
        let session2 = session.clone();
        std::thread::Builder::new()
            .name(format!("pty-{sid}"))
            .spawn(move || {
                let data_evt = data_event(&sid);
                let mut buf = vec![0u8; 8192];
                // Windows ConPTY quirk: when a child TUI (OpenCode, …) exits it
                // can transiently break the master read handle *while the shell
                // is still alive*. Declaring the session dead on the first read
                // error made the terminal show "连接已关闭" whenever the user
                // quit such a tool. Instead, keep retrying as long as the child
                // process is still running; only give up after a generous grace
                // window (200 × 50ms = 10s) of persistent errors.
                let mut read_errs = 0u32;
                const READ_ERR_RETRY_LIMIT: u32 = 200;
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break, // clean EOF: the child closed the tty
                        Ok(n) => {
                            read_errs = 0;
                            // Buffered until the terminal attaches, so the
                            // shell banner and first prompt survive the gap.
                            if output.accept(&buf[..n]) {
                                let _ = app.emit(
                                    &data_evt,
                                    StreamChunk {
                                        session_id: sid.clone(),
                                        data: B64.encode(&buf[..n]),
                                    },
                                );
                                crate::perm::scan_and_emit(&app, &sid, &buf[..n]);
                            }
                        }
                        Err(e) => {
                            let child_alive = session2
                                .child
                                .lock()
                                .try_wait()
                                .map(|w| w.is_none())
                                .unwrap_or(false);
                            if child_alive && read_errs < READ_ERR_RETRY_LIMIT {
                                read_errs += 1;
                                std::thread::sleep(Duration::from_millis(50));
                                continue;
                            }
                            eprintln!("[pty-{sid}] read error after {read_errs} retries: {e}");
                            break;
                        }
                    }
                }
                // The ConPTY read can EOF (or error out past the retry window)
                // while the shell process is STILL alive — a child TUI (OpenCode,
                // …) exiting abruptly (e.g. rapid double Ctrl+C) can tear down
                // the whole pseudoconsole pipe, orphaning the shell. That session
                // is unrecoverable: signal the UI to restart the shell in place
                // (restart = true) instead of showing a fatal "connection closed"
                // overlay, and kill the orphan so it doesn't linger.
                let child_alive = session2
                    .child
                    .lock()
                    .try_wait()
                    .map(|w| w.is_none())
                    .unwrap_or(false);
                let closed = SessionClosed {
                    session_id: sid.clone(),
                    reason: if child_alive {
                        "terminal I/O lost; restarting shell".into()
                    } else {
                        exit_reason.into()
                    },
                    exit_code: None,
                    restart: Some(child_alive),
                };
                if output.accept_closed(&closed) {
                    let _ = app.emit(&closed_event(&sid), closed);
                }
                if child_alive {
                    let _ = session2.child.lock().kill();
                }
            })
            .map_err(|e| AppError::Other(format!("cannot spawn pty thread: {e}")))?;

        Ok(session_id)
    }
}

/// Resolve the shell a local PTY should launch, by platform:
/// - Windows: prefer `pwsh.exe`, then `powershell.exe`, then `cmd.exe` (via COMSPEC).
/// - Elsewhere: the user's `$SHELL`, falling back to `/bin/bash`.
///
/// Exposed to the frontend as the `default_shell` command so the UI can both
/// spawn *exactly* this shell and pick the matching OSC 7 cwd emitter without
/// re-implementing the platform logic on the JS side.
pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        // Prefer PowerShell, fall back to cmd.exe.
        if which("pwsh.exe") {
            return "pwsh.exe".into();
        }
        if which("powershell.exe") {
            return "powershell.exe".into();
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[cfg(windows)]
fn which(exe: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| dir.join(exe).is_file())
        })
        .unwrap_or(false)
}
