#![allow(dependency_on_unit_never_type_fallback)]
mod ai;
pub use ai::ai_chat;
mod error;
mod fonts;
mod frp;
mod kb;
mod pty;
mod serial;
mod ssh;
mod storage;
mod stream;
mod system;
mod types;
mod wsl;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::{AppHandle, Manager, State};

use error::{AppError, AppResult};
use pty::PtyManager;
use serial::SerialManager;
use ssh::{metrics::MetricsCache, SshManager};
use storage::Store;
use stream::Attached;
use system::LocalMonitor;
use types::*;

pub struct AppState {
    ssh: SshManager,
    serial: SerialManager,
    pty: PtyManager,
    store: Store,
    metrics: MetricsCache,
    local: LocalMonitor,
}

fn decode(data: &str) -> AppResult<Vec<u8>> {
    B64.decode(data)
        .map_err(|e| AppError::Other(format!("bad base64 payload: {e}")))
}

// ===========================================================================
// SSH
// ===========================================================================

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SshConnectConfig,
) -> AppResult<SshConnectResult> {
    let mut config = config;

    // Resolve `__saved__` sentinels against the encrypted store.
    if let Some(host_id) = config.host_id.clone() {
        if config.password.as_deref() == Some("__saved__") {
            config.password = state.store.reveal_secret(&host_id, "password")?;
        }
        if config.passphrase.as_deref() == Some("__saved__") {
            config.passphrase = state.store.reveal_secret(&host_id, "passphrase")?;
        }
        let _ = state.store.touch_host(&host_id);
    }

    state.ssh.connect(app, config).await
}

#[tauri::command]
async fn ssh_write(state: State<'_, AppState>, session_id: String, data: String) -> AppResult<()> {
    let session = state.ssh.get(&session_id).await?;
    session.write(&decode(&data)?).await
}

#[tauri::command]
async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> AppResult<()> {
    let session = state.ssh.get(&session_id).await?;
    session.resize(cols, rows).await
}

#[tauri::command]
async fn ssh_exec(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> AppResult<String> {
    let session = state.ssh.get(&session_id).await?;
    session.exec(&command).await
}

#[tauri::command]
async fn ssh_disconnect(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state.metrics.forget(&session_id).await;
    state.ssh.disconnect(&session_id).await
}

#[tauri::command]
async fn ssh_sessions(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.ssh.ids().await)
}

/// Called by the terminal once its event listener is live. Returns everything
/// the remote shell emitted in the meantime (MOTD, first prompt) and switches
/// the session to live streaming.
#[tauri::command]
async fn ssh_attach(state: State<'_, AppState>, session_id: String) -> AppResult<Attached> {
    Ok(state.ssh.get(&session_id).await?.attach())
}

// ===========================================================================
// SFTP
// ===========================================================================

#[tauri::command]
async fn sftp_list(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<Vec<RemoteFile>> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::list(&session, &path).await
}

#[tauri::command]
async fn sftp_realpath(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<String> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::realpath(&session, &path).await
}

#[tauri::command]
async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<()> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::mkdir(&session, &path).await
}

#[tauri::command]
async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> AppResult<()> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::remove(&session, &path, is_dir).await
}

#[tauri::command]
async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from: String,
    to: String,
) -> AppResult<()> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::rename(&session, &from, &to).await
}

#[tauri::command]
async fn sftp_download(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> AppResult<()> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::download(&app, &session, &remote_path, &local_path, &transfer_id).await
}

#[tauri::command]
async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_dir: String,
    transfer_id: String,
) -> AppResult<String> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::upload(&app, &session, &local_path, &remote_dir, &transfer_id).await
}

// ===========================================================================
// Monitoring
// ===========================================================================

#[tauri::command]
async fn remote_metrics(state: State<'_, AppState>, session_id: String) -> AppResult<HostMetrics> {
    let session = state.ssh.get(&session_id).await?;
    ssh::metrics::collect(&session, &state.metrics).await
}

#[tauri::command]
async fn local_metrics(state: State<'_, AppState>) -> AppResult<HostMetrics> {
    state.local.sample()
}

// ===========================================================================
// Serial
// ===========================================================================

#[tauri::command]
fn serial_list_ports() -> AppResult<Vec<SerialPortInfo>> {
    serial::list_ports()
}

#[tauri::command]
fn serial_baud_rates() -> Vec<u32> {
    serial::COMMON_BAUD_RATES.to_vec()
}

#[tauri::command]
async fn serial_open(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SerialOpenConfig,
) -> AppResult<String> {
    if let Some(host_id) = config.host_id.clone() {
        let _ = state.store.touch_host(&host_id);
    }
    state.serial.open(app, config)
}

#[tauri::command]
async fn serial_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> AppResult<()> {
    state.serial.get(&session_id)?.write(&decode(&data)?)
}

#[tauri::command]
async fn serial_signals(
    state: State<'_, AppState>,
    session_id: String,
    dtr: Option<bool>,
    rts: Option<bool>,
) -> AppResult<()> {
    state.serial.get(&session_id)?.set_signals(dtr, rts)
}

#[tauri::command]
async fn serial_close(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state.serial.close(&session_id)
}

/// See [`ssh_attach`] — same handshake, for a board that boot-logs on open.
#[tauri::command]
async fn serial_attach(state: State<'_, AppState>, session_id: String) -> AppResult<Attached> {
    Ok(state.serial.get(&session_id)?.attach())
}

// ===========================================================================
// Local PTY
// ===========================================================================

#[tauri::command]
async fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> AppResult<String> {
    state.pty.spawn(app, shell, cwd, cols, rows)
}

#[tauri::command]
async fn pty_write(state: State<'_, AppState>, session_id: String, data: String) -> AppResult<()> {
    state.pty.get(&session_id)?.write(&decode(&data)?)
}

#[tauri::command]
async fn pty_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> AppResult<()> {
    state.pty.get(&session_id)?.resize(cols, rows)
}

#[tauri::command]
async fn pty_close(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state.pty.close(&session_id)
}

/// See [`ssh_attach`] — same handshake, for the local shell banner and prompt.
#[tauri::command]
async fn pty_attach(state: State<'_, AppState>, session_id: String) -> AppResult<Attached> {
    Ok(state.pty.get(&session_id)?.attach())
}

// ===========================================================================
// WSL
// ===========================================================================

/// Enumerate installed WSL distributions.
///
/// An empty vec means WSL runs fine but has no distros installed; an `Err`
/// means `wsl.exe` itself is missing or refused to run.
#[tauri::command]
async fn wsl_list_distros() -> AppResult<Vec<wsl::WslDistro>> {
    wsl::list_distros()
}

/// Open a shell inside a WSL distro. The result is an ordinary PTY session, so
/// `pty_write` / `pty_resize` / `pty_close` / `pty_attach` all apply to it.
#[tauri::command]
async fn wsl_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    distro: Option<String>,
    user: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> AppResult<String> {
    state.pty.spawn_wsl(app, distro, user, cwd, cols, rows)
}

// ===========================================================================
// WSL filesystem (mirrors the SFTP command set; see `wsl::` for the impl)
// ===========================================================================

#[tauri::command]
async fn wsl_list(distro: Option<String>, path: String) -> AppResult<Vec<RemoteFile>> {
    wsl::list(&distro, &path).await
}

#[tauri::command]
async fn wsl_home(distro: Option<String>) -> AppResult<String> {
    wsl::home(&distro).await
}

#[tauri::command]
async fn wsl_mkdir(distro: Option<String>, path: String) -> AppResult<()> {
    wsl::mkdir(&distro, &path).await
}

#[tauri::command]
async fn wsl_remove(distro: Option<String>, path: String, is_dir: bool) -> AppResult<()> {
    wsl::remove(&distro, &path, is_dir).await
}

#[tauri::command]
async fn wsl_rename(distro: Option<String>, from: String, to: String) -> AppResult<()> {
    wsl::rename(&distro, &from, &to).await
}

#[tauri::command]
async fn wsl_download(
    app: AppHandle,
    distro: Option<String>,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> AppResult<()> {
    wsl::download(&app, &distro, &remote_path, &local_path, &transfer_id).await
}

#[tauri::command]
async fn wsl_upload(
    app: AppHandle,
    distro: Option<String>,
    local_path: String,
    remote_dir: String,
    transfer_id: String,
) -> AppResult<String> {
    wsl::upload(&app, &distro, &local_path, &remote_dir, &transfer_id).await
}

// ===========================================================================
// Frp
// ===========================================================================

/// Start an `frpc` tunnel. The `config` is turned into an `frpc.toml`, the
/// `frpc` binary is located (bundled resource → next to exe → PATH), and the
/// process is launched on a PTY. Its log output streams to the terminal; close
/// the tab or send Ctrl-C to stop it.
#[tauri::command]
async fn frp_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    config: frp::FrpConfig,
    cols: u16,
    rows: u16,
) -> AppResult<String> {
    let frpc = frp::locate_frpc(&app)?;
    let cfg_path = frp::write_config_file(&config)?;
    state.pty.spawn_frp(
        app,
        frpc.to_string_lossy().to_string(),
        cfg_path.to_string_lossy().to_string(),
        cols,
        rows,
    )
}

// ===========================================================================
// Storage
// ===========================================================================

#[tauri::command]
fn db_list_hosts(state: State<'_, AppState>) -> AppResult<Vec<Host>> {
    state.store.list_hosts()
}

#[tauri::command]
fn db_save_host(state: State<'_, AppState>, host: Host) -> AppResult<Host> {
    state.store.save_host(host)
}

#[tauri::command]
fn db_delete_host(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.delete_host(&id)
}

#[tauri::command]
fn db_list_quick_commands(state: State<'_, AppState>) -> AppResult<Vec<QuickCommand>> {
    state.store.list_quick_commands()
}

#[tauri::command]
fn db_save_quick_command(
    state: State<'_, AppState>,
    command: QuickCommand,
) -> AppResult<QuickCommand> {
    state.store.save_quick_command(command)
}

#[tauri::command]
fn db_delete_quick_command(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.delete_quick_command(&id)
}

#[tauri::command]
fn db_get_settings(state: State<'_, AppState>) -> AppResult<serde_json::Value> {
    state.store.get_settings()
}

#[tauri::command]
fn db_set_setting(
    state: State<'_, AppState>,
    key: String,
    value: serde_json::Value,
) -> AppResult<()> {
    state.store.set_setting(&key, &value)
}

// ===========================================================================
// Bootstrap
// ===========================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
            let store = Store::new(&data_dir)?;

            app.manage(AppState {
                ssh: SshManager::default(),
                serial: SerialManager::default(),
                pty: PtyManager::default(),
                store,
                metrics: MetricsCache::default(),
                local: LocalMonitor::new(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Tear every live session down cleanly so remote shells don't linger.
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    state.serial.close_all();
                    state.pty.close_all();
                    // SSH teardown is async. Block briefly on the event-loop
                    // thread so remote shells receive a real disconnect instead
                    // of being left to time out as half-open TCP sessions.
                    tauri::async_runtime::block_on(state.ssh.disconnect_all());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_exec,
            ssh_disconnect,
            ssh_sessions,
            ssh_attach,
            sftp_list,
            sftp_realpath,
            sftp_mkdir,
            sftp_remove,
            sftp_rename,
            sftp_download,
            sftp_upload,
            remote_metrics,
            local_metrics,
            serial_list_ports,
            serial_baud_rates,
            serial_open,
            serial_write,
            serial_signals,
            serial_close,
            serial_attach,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
            pty_attach,
            wsl_list_distros,
            wsl_spawn,
            wsl_list,
            wsl_home,
            wsl_mkdir,
            wsl_remove,
            wsl_rename,
            wsl_download,
            wsl_upload,
            frp_spawn,
            ai_chat,
            fonts::list_fonts,
            fonts::import_font,
            fonts::list_imported_fonts,
            fonts::read_font,
            kb::kb_scan,
            kb::kb_read,
            db_list_hosts,
            db_save_host,
            db_delete_host,
            db_list_quick_commands,
            db_save_quick_command,
            db_delete_quick_command,
            db_get_settings,
            db_set_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevOps Station");
}
