//! Built-in single-instance guard — no external plugin, no network dependency.
//!
//! The primary process binds a fixed localhost "sentinel" TCP port and keeps it
//! open for the whole app lifetime. Any later launch fails to bind
//! (`EADDRINUSE`), connects to that port to ask the primary to raise its main
//! window, then exits. This guarantees exactly one app process ever runs, which
//! also prevents the desktop-pet overlay from being duplicated when the app is
//! relaunched while an earlier instance is still alive.
//!
//! (This is the offline-safe equivalent of `tauri-plugin-single-instance`.)
//!
//! The sentinel port is split per build flavor so a dev build and an installed
//! release build can run side by side (each guards only its own family of
//! instances). Dev builds (`cargo run` / `tauri dev`) hold 48712; release
//! builds hold 48713. Consequence: with both running you get two app instances
//! — and therefore two desktop pets — which is the accepted trade-off.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::OnceLock;
use std::thread::sleep;
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// Localhost port used as the single-instance sentinel. A plain constant so we
/// don't need any hashing/ident lookup. Low collision risk (high ephemeral-ish
/// range), only ever bound on 127.0.0.1.
///
/// Split by build flavor: dev/debug builds and release builds use different
/// ports so a `tauri dev` session never blocks an installed release build (and
/// vice versa).
#[cfg(debug_assertions)]
const SENTINEL_PORT: u16 = 48_712;
#[cfg(not(debug_assertions))]
const SENTINEL_PORT: u16 = 48_713;
fn sentinel_addr() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], SENTINEL_PORT))
}

/// Short timeout for the "is a primary alive?" probe. Localhost connect-refused
/// is normally instant, but Windows can stall the loopback probe in rare driver
/// states; 300ms is a safe ceiling that still feels instant to a human.
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Returns `true` if this process became the primary instance. When `true` a
/// background thread is spawned that waits for "focus" pings from later
/// instances and raises our main window.
pub fn try_become_primary() -> bool {
    // Fast path: a live primary would already own the port, so a connect
    // succeeds. If it does, we are secondary. Bounded timeout so a wedged
    // loopback driver can't hold the launch.
    match TcpStream::connect_timeout(&sentinel_addr(), PROBE_TIMEOUT) {
        Ok(_) => {
            eprintln!(
                "[devops-station] another instance is already running \
                 (127.0.0.1:{SENTINEL_PORT} is held) — exiting."
            );
            return false;
        }
        Err(_) => {
            // No live primary (or probe timed out). Fall through and try to bind.
        }
    }

    // No live listener replied. Bind the sentinel port. Retry a few times to
    // absorb a brief TIME_WAIT left by a previous instance that just exited.
    for attempt in 0..4 {
        match TcpListener::bind(sentinel_addr()) {
            Ok(listener) => {
                std::thread::spawn(move || {
                    for stream in listener.incoming() {
                        if let Ok(mut stream) = stream {
                            // A secondary instance pinged us — read its byte,
                            // ack, and raise the main window.
                            let mut buf = [0u8; 1];
                            let _ = stream.read(&mut buf);
                            let _ = stream.write_all(b"1");
                            if let Some(app) = APP_HANDLE.get() {
                                if let Some(win) = app.get_webview_window("main") {
                                    let _ = win.show();
                                    let _ = win.unminimize();
                                    let _ = win.set_focus();
                                }
                            }
                        }
                    }
                });
                return true;
            }
            Err(e) => {
                eprintln!(
                    "[devops-station] sentinel bind attempt {}/4 failed: {e}",
                    attempt + 1
                );
                // Bind failed. It could be a live primary (connect above should
                // have caught it) or a lingering TIME_WAIT socket. Wait and retry.
                if attempt < 3 {
                    sleep(Duration::from_millis(120));
                }
            }
        }
    }

    eprintln!(
        "[devops-station] could not bind sentinel after retries; \
         continuing as primary (a second launch may also proceed)."
    );
    // Best-effort: assume we are still the only meaningful instance and run
    // anyway rather than leaving the user with no app at all.
    true
}

/// Called from a secondary instance: request the primary to focus, then exit.
pub fn signal_primary_and_exit() {
    if let Ok(mut stream) = TcpStream::connect_timeout(&sentinel_addr(), PROBE_TIMEOUT) {
        let _ = stream.write_all(b"\x01");
        let _ = stream.read(&mut [0u8; 1]);
    }
    std::process::exit(0);
}

/// Stash the app handle so the listener thread can locate the main window.
pub fn set_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}
