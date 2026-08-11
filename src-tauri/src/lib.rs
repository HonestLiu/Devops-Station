#![allow(dependency_on_unit_never_type_fallback)]
mod ai;
pub use ai::ai_chat;
mod ble;
mod error;
mod fonts;
mod frp;
mod jlink;
mod kb;
mod local_fs;
mod notify;
mod perm;
mod pty;
mod serial;
mod ssh;
mod storage;
mod stream;
mod sync;
mod system;
mod types;
mod wsl;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::path::Path;
use tauri::{AppHandle, Manager, State};

use ble::BleManager;
use error::{AppError, AppResult};
use pty::PtyManager;
use serial::SerialManager;
use ssh::{metrics::MetricsCache, SshManager};
use storage::{ProfileExportInfo, ProfileImportInfo, Store};
use stream::Attached;
use system::LocalMonitor;
use types::*;

pub struct AppState {
    ssh: SshManager,
    serial: SerialManager,
    ble: BleManager,
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
    offset: Option<u64>,
) -> AppResult<()> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::download(&app, &session, &remote_path, &local_path, &transfer_id, offset).await
}

#[tauri::command]
async fn sftp_upload(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_dir: String,
    transfer_id: String,
    offset: Option<u64>,
) -> AppResult<String> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::upload(&app, &session, &local_path, &remote_dir, &transfer_id, offset).await
}

#[tauri::command]
async fn sftp_stat(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> AppResult<RemoteFileMeta> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::stat(&session, &path).await
}

#[tauri::command]
async fn sftp_read(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
) -> AppResult<String> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::read_string(&session, &remote_path).await
}

#[tauri::command]
async fn sftp_write(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    content: String,
) -> AppResult<()> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::write_string(&session, &remote_path, &content).await
}

#[tauri::command]
async fn sftp_set_perms(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    permissions: Option<u32>,
    owner: Option<String>,
    group: Option<String>,
) -> AppResult<()> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::set_perms(&session, &path, permissions, owner, group).await
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
// Bluetooth Low Energy
//
// Deliberately mirrors the serial command surface: a BLE session emits the same
// `StreamChunk` / `SessionClosed` payloads, so the UI reuses one data pipeline.
// ===========================================================================

#[tauri::command]
async fn ble_available(state: State<'_, AppState>) -> AppResult<bool> {
    Ok(state.ble.available().await)
}

#[tauri::command]
async fn ble_scan(
    state: State<'_, AppState>,
    duration_ms: Option<u64>,
    service: Option<String>,
) -> AppResult<Vec<BleDeviceInfo>> {
    state.ble.scan(duration_ms.unwrap_or(4000), service).await
}

#[tauri::command]
async fn ble_open(
    app: AppHandle,
    state: State<'_, AppState>,
    config: BleOpenConfig,
) -> AppResult<String> {
    if let Some(host_id) = config.host_id.clone() {
        let _ = state.store.touch_host(&host_id);
    }
    state.ble.open(app, config).await
}

#[tauri::command]
async fn ble_write(state: State<'_, AppState>, session_id: String, data: String) -> AppResult<()> {
    let session = state.ble.get(&session_id)?;
    session.write(&decode(&data)?).await
}

#[tauri::command]
async fn ble_close(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    state.ble.close(&session_id).await
}

/// See [`serial_attach`] — a bridge module often notifies the instant we
/// subscribe, before React has mounted its listener.
#[tauri::command]
async fn ble_attach(state: State<'_, AppState>, session_id: String) -> AppResult<Attached> {
    Ok(state.ble.get(&session_id)?.attach())
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

/// The shell a *default* local PTY would launch on this machine, resolved by
/// platform (see `pty::default_shell`). The frontend calls this when the user
/// picks "Default (OS login shell)" so it can spawn that exact shell and inject
/// the matching OSC 7 cwd emitter — instead of guessing per-OS on the JS side.
#[tauri::command]
fn default_shell() -> String {
    pty::default_shell()
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
// WSL USB Device Manager (usbipd-win)
//
// These commands invoke external processes (`usbipd`, `wsl.exe`) that can block
// or hang. They run on Tauri's *dedicated blocking pool* via `spawn_blocking`
// (not the compute pool that runs `pty_write`/`ssh_write`), so a slow or stuck
// `usbipd list` can never freeze terminal input. Each underlying process call
// also has its own hard timeout (see `wsl::usbip::run_captured`).
// ===========================================================================

/// Whether `usbipd-win` is installed on the Windows host.
#[tauri::command]
async fn usbip_installed() -> bool {
    tauri::async_runtime::spawn_blocking(crate::wsl::usbip::is_installed)
        .await
        .unwrap_or(false)
}

/// Enumerate embedded-dev USB devices currently visible to Windows.
#[tauri::command]
async fn usbip_list() -> AppResult<Vec<crate::wsl::usbip::UsbDevice>> {
    tauri::async_runtime::spawn_blocking(crate::wsl::usbip::list_devices)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(AppError::Other)
}

/// Bind (if needed) and attach a device into the given WSL distro, then verify.
#[tauri::command]
async fn usbip_attach(busid: String, distro: String) -> AppResult<crate::wsl::usbip::UsbVerify> {
    tauri::async_runtime::spawn_blocking(move || crate::wsl::usbip::attach(&busid, &distro))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(AppError::Other)
}

/// Detach a device, returning it to Windows.
#[tauri::command]
async fn usbip_detach(busid: String) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || crate::wsl::usbip::detach(&busid))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(AppError::Other)
}

/// Re-verify an attached device inside WSL (`lsusb` + serial port probe).
#[tauri::command]
async fn usbip_verify(distro: String) -> AppResult<crate::wsl::usbip::UsbVerify> {
    tauri::async_runtime::spawn_blocking(move || crate::wsl::usbip::verify(&distro))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(AppError::Other)
}

/// Launch the interactive winget installer for usbipd-win.
#[tauri::command]
async fn usbip_install() -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(crate::wsl::usbip::install)
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(AppError::Other)
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

#[tauri::command]
fn profile_export(
    state: State<'_, AppState>,
    path: String,
    include_secrets: bool,
) -> AppResult<ProfileExportInfo> {
    state.store.export_profile(
        Path::new(&path),
        include_secrets,
        env!("CARGO_PKG_VERSION"),
    )
}

#[tauri::command]
fn profile_import(
    state: State<'_, AppState>,
    path: String,
    mode: String,
) -> AppResult<ProfileImportInfo> {
    state.store.import_profile(Path::new(&path), &mode)
}

#[tauri::command]
async fn sync_test(cfg: sync::SyncConfig) -> AppResult<sync::SyncTestResult> {
    sync::sync_test(cfg).await
}

#[tauri::command]
async fn sync_push(
    state: State<'_, AppState>,
    cfg: sync::SyncConfig,
) -> AppResult<sync::SyncPushResult> {
    sync::sync_push(cfg, &state.store).await
}

#[tauri::command]
async fn sync_pull(
    state: State<'_, AppState>,
    cfg: sync::SyncConfig,
) -> AppResult<sync::SyncPullResult> {
    sync::sync_pull(cfg, &state.store).await
}

// ===========================================================================
// Bootstrap
// ===========================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_notification::init())
            .setup(|app| {
            // Ensure OS notifications are attributed to this app (not
            // "Windows PowerShell") by registering our Start Menu shortcut +
            // AUMID on Windows. Safe no-op on other platforms / release builds
            // that already ship the shortcut via the installer.
            crate::notify::register_aumid();

            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
            let store = Store::new(&data_dir)?;

            app.manage(AppState {
                ssh: SshManager::default(),
                serial: SerialManager::default(),
                ble: BleManager::default(),
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
                    state.ble.close_all();
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
            sftp_stat,
            sftp_read,
            sftp_write,
            sftp_set_perms,
            remote_metrics,
            local_metrics,
            serial_list_ports,
            serial_baud_rates,
            serial_open,
            serial_write,
            serial_signals,
            serial_close,
            serial_attach,
            ble_available,
            ble_scan,
            ble_open,
            ble_write,
            ble_close,
            ble_attach,
    pty_spawn,
    pty_write,
    pty_resize,
    pty_close,
    pty_attach,
    default_shell,
            wsl_list_distros,
            wsl_spawn,
            wsl_list,
            wsl_home,
            wsl_mkdir,
            wsl_remove,
            wsl_rename,
            wsl_download,
            wsl_upload,
            usbip_installed,
            usbip_list,
            usbip_attach,
            usbip_detach,
            usbip_verify,
            usbip_install,
            frp_spawn,
            ai_chat,
            fonts::list_fonts,
            fonts::import_font,
            fonts::list_imported_fonts,
            fonts::read_font,
            kb::kb_scan,
            kb::kb_read,
            local_fs::local_home,
            local_fs::local_list,
            local_fs::reveal_path,
            local_fs::open_path,
            jlink::jlink_available,
            jlink::jlink_connect,
            jlink::jlink_reset,
            jlink::jlink_read_mem,
            jlink::jlink_write_mem,
            jlink::jlink_erase,
            jlink::jlink_program,
            jlink::jlink_gdb_start,
            jlink::jlink_gdb_stop,
            jlink::jlink_gdb_running,
            jlink::jlink_devices,
            db_list_hosts,
            db_save_host,
            db_delete_host,
            db_list_quick_commands,
            db_save_quick_command,
            db_delete_quick_command,
            db_get_settings,
            db_set_setting,
            profile_export,
            profile_import,
            sync_test,
            sync_push,
            sync_pull,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DevOps Station");
}
