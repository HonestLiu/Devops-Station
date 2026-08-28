#![allow(dependency_on_unit_never_type_fallback)]
mod ai;
pub use ai::{ai_cancel, ai_chat, ai_clear_inflight};
mod ble;
mod docker;
mod error;
mod fonts;
mod frp;
mod git;
mod jlink;
mod kb;
mod local_fs;
mod mqtt;
mod notify;
mod perm;
mod perm_aggregator;
mod perm_hook;
mod protocol;
pub use protocol::{
    protocol_delete, protocol_duplicate, protocol_encode, protocol_list, protocol_load,
    protocol_loopback_close, protocol_loopback_open, protocol_loopback_reload,
    protocol_loopback_send, protocol_parse, protocol_save, protocol_validate, ProtocolManager,
};
mod pty;
mod serial;
mod single_instance;
mod ssh;
mod storage;
mod stream;
mod sync;
mod system;
mod types;
mod wsl;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::path::Path;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use ble::BleManager;
use error::{AppError, AppResult};
use mqtt::MqttManager;
use pty::PtyManager;
use serial::SerialManager;
use ssh::{forward::PortForwardManager, metrics::MetricsCache, SshManager};
use storage::{ProfileExportInfo, ProfileImportInfo, Store};
use stream::Attached;
use system::LocalMonitor;
use types::*;

// QuickJS sandbox types for HMI dashboard parse/publish evaluation (see dash_eval).
use rquickjs::{Context as QjsContext, Value as QjsValue};

pub struct AppState {
    ssh: SshManager,
    serial: SerialManager,
    protocol: ProtocolManager,
    ble: BleManager,
    mqtt: MqttManager,
    pty: PtyManager,
    forward: PortForwardManager,
    store: Arc<Store>,
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

    let result = state.ssh.connect(app, config.clone()).await?;
    // Auto-start any port forwards flagged for this host.
    if let Some(host_id) = &config.host_id {
        if let Ok(session) = state.ssh.get(&result.session_id).await {
            state.forward.start_auto_for(&session, host_id).await;
        }
    }
    Ok(result)
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
    state.forward.stop_for_session(&session_id).await;
    state.ssh.disconnect(&session_id).await
}

#[tauri::command]
async fn ssh_sessions(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    Ok(state.ssh.ids().await)
}

// ===========================================================================
// SSH port forwarding
// ===========================================================================

#[tauri::command]
async fn ssh_forward_list(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<Vec<PortForwardStatus>> {
    Ok(state.forward.list(&session_id).await)
}

#[tauri::command]
async fn ssh_forward_start(
    state: State<'_, AppState>,
    session_id: String,
    rule: PortForwardRule,
) -> AppResult<PortForwardStatus> {
    let session = state.ssh.get(&session_id).await?;
    state.forward.start(session, rule).await
}

#[tauri::command]
async fn ssh_forward_stop(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    state.forward.stop(&id).await
}

#[tauri::command]
async fn ssh_forward_save(
    state: State<'_, AppState>,
    rule: PortForwardRule,
) -> AppResult<PortForwardRule> {
    state.store.save_port_forward(rule)
}

#[tauri::command]
async fn ssh_forward_delete(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    state.forward.stop(&id).await?;
    state.store.delete_port_forward(&id)
}

#[tauri::command]
async fn ssh_forward_rules(
    state: State<'_, AppState>,
    host_id: String,
) -> AppResult<Vec<PortForwardRule>> {
    state.store.list_port_forwards(&host_id)
}

// ===========================================================================
// Known hosts
// ===========================================================================

#[tauri::command]
async fn ssh_known_hosts_list(state: State<'_, AppState>) -> AppResult<Vec<KnownHostEntry>> {
    state.store.known_hosts_list()
}

#[tauri::command]
async fn ssh_known_hosts_remove(
    state: State<'_, AppState>,
    host: String,
    port: u16,
) -> AppResult<()> {
    state.store.known_hosts_remove(&host, port)
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
async fn sftp_read_bytes(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
) -> AppResult<String> {
    let session = state.ssh.get(&session_id).await?;
    ssh::sftp::read_bytes(&session, &remote_path).await
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
    host_id: Option<String>,
    distro: Option<String>,
    user: Option<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> AppResult<String> {
    if let Some(id) = host_id.as_deref() {
        let _ = state.store.touch_host(id);
    }
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
    host_id: Option<String>,
    config: frp::FrpConfig,
    cols: u16,
    rows: u16,
) -> AppResult<String> {
    if let Some(id) = host_id.as_deref() {
        let _ = state.store.touch_host(id);
    }
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

/// Raise a native OS notification attributed to this app. Used by the frontend
/// to alert the user that a terminal session is waiting for input (e.g. when an
/// agent CLI is blocked on an approval/confirmation prompt).
#[tauri::command]
fn notify_show(app: AppHandle, title: String, body: String) {
    crate::notify::show(&app, &title, &body);
}

/// Enable or disable native OS notifications for agent/CLI approval prompts.
#[tauri::command]
fn set_approval_notifications(enabled: bool) {
    crate::perm::set_approval_notifications(enabled);
}

/// Enable or disable the legacy terminal-output approval scan (compat mode).
#[tauri::command]
fn set_scan_fallback(enabled: bool) {
    crate::perm::set_scan_fallback(enabled);
}

/// Snapshot of the AI-agent activity state (per-project traffic lights) for the
/// frontend status widget. The same data is also pushed via the
/// `perm-state-changed` event whenever it changes.
#[tauri::command]
fn perm_state() -> crate::perm_aggregator::PermState {
    crate::perm_aggregator::global()
        .map(|a| a.get_state())
        .unwrap_or_default()
}

/// Tell the backend the user has acted on (approved / rejected / dismissed) a
/// given agent session, so escalation stops and the traffic light clears.
#[tauri::command]
fn perm_ack(session_id: String) {
    if let Some(a) = crate::perm_aggregator::global() {
        a.ack(&session_id);
    }
}

/// Terminate the application process. Called by the frontend after the
/// `confirm-exit` dialog accepts; the backend side of the close-request hook
/// has already called `api.prevent_close()`, so we have to drive the exit
/// ourselves from JS-land.
#[tauri::command]
fn app_exit(app: AppHandle) {
    // `exit(0)` skips the cleanup hooks (good — by the time the user
    // confirmed, the UI already tore down the active sessions via the
    // `Destroyed` handler in the normal close path; here we just want out).
    // Use 130 to signal "user-confirmed exit" in case we ever add logging.
    app.exit(130);
}

/// Register (or clear) the OS-level quick-approve shortcut. The accelerator is
/// a plugin-format string like "Ctrl+Shift+Enter"; an empty string unregisters.
/// While registered, pressing the combo anywhere on the system emits
/// `approval-shortcut` to the frontend, which forwards Enter to the terminal
/// currently waiting on an agent CLI approval prompt.
#[tauri::command]
fn set_global_approve_shortcut(app: tauri::AppHandle, accelerator: String) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

    let gs = app.global_shortcut();
    // Drop any previously registered combo first — re-registering the same
    // accelerator after a change would otherwise stack handlers.
    gs.unregister_all().map_err(|e| format!("清理旧快捷键失败：{e}"))?;

    let acc = accelerator.trim();
    if acc.is_empty() {
        return Ok(());
    }
    let shortcut: Shortcut = acc
        .parse()
        .map_err(|e| format!("无效快捷键 {acc}: {e}"))?;
    gs.on_shortcut(shortcut, |app, _sc, _state| {
        let _ = app.emit("approval-shortcut", ());
    })
    .map_err(|e| format!("注册全局快捷键失败：{e}"))?;
    Ok(())
}

// ===========================================================================
// Storage
// ===========================================================================

#[tauri::command]
fn db_list_hosts(
    state: State<'_, AppState>,
    include_secrets: Option<bool>,
) -> AppResult<Vec<Host>> {
    // Default (no arg) = masked, exactly as the UI expects. Passing
    // `include_secrets: true` inlines the real decrypted credentials so the
    // sync push can carry them to other devices (see src/lib/sync.ts).
    if include_secrets.unwrap_or(false) {
        state.store.list_hosts_for_sync()
    } else {
        state.store.list_hosts()
    }
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
async fn sync_test(
    state: State<'_, AppState>,
    mut cfg: sync::SyncConfig,
) -> AppResult<sync::SyncTestResult> {
    cfg.device_id = state.store.device_id();
    sync::sync_test(cfg).await
}

#[tauri::command]
async fn sync_push(
    state: State<'_, AppState>,
    mut cfg: sync::SyncConfig,
) -> AppResult<sync::SyncPushResult> {
    cfg.device_id = state.store.device_id();
    sync::sync_push(cfg, &state.store).await
}

#[tauri::command]
async fn sync_pull(
    state: State<'_, AppState>,
    mut cfg: sync::SyncConfig,
) -> AppResult<sync::SyncPullResult> {
    cfg.device_id = state.store.device_id();
    sync::sync_pull(cfg, &state.store).await
}

// ===========================================================================
// Bootstrap
// ===========================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ===========================================================================
// MQTT (ported MQTTX-style functionality)
// ===========================================================================

#[tauri::command]
async fn mqtt_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    config: MqttConnectConfig,
) -> AppResult<String> {
    state.mqtt.connect(app, &state.store, config)
}

#[tauri::command]
async fn mqtt_disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.mqtt.disconnect(&id)
}

#[tauri::command]
async fn mqtt_publish(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    topic: String,
    payload: String,
    qos: u8,
    retain: bool,
    host_id: Option<String>,
) -> AppResult<()> {
    let bytes = B64
        .decode(&payload)
        .map_err(|e| AppError::Mqtt(format!("bad base64 payload: {e}")))?;
    state.mqtt.publish(&app, &id, &topic, &bytes, qos, retain).await?;
    // Persist the publish form so it is restored on reconnect / on other devices.
    if let Some(h) = host_id {
        let decoded = String::from_utf8_lossy(&bytes).to_string();
        state.store.set_mqtt_publish_pref(&h, &topic, qos, retain, &decoded)?;
    }
    Ok(())
}

#[tauri::command]
async fn mqtt_subscribe(
    state: State<'_, AppState>,
    id: String,
    topic: String,
    qos: u8,
    host_id: Option<String>,
) -> AppResult<()> {
    state.mqtt.subscribe(&id, &topic, qos).await?;
    if let Some(h) = host_id {
        state.store.add_mqtt_subscription(&h, &topic, qos)?;
    }
    Ok(())
}

#[tauri::command]
async fn mqtt_unsubscribe(
    state: State<'_, AppState>,
    id: String,
    topic: String,
    host_id: Option<String>,
) -> AppResult<()> {
    state.mqtt.unsubscribe(&id, &topic).await?;
    if let Some(h) = host_id {
        state.store.remove_mqtt_subscription(&h, &topic)?;
    }
    Ok(())
}

#[tauri::command]
async fn mqtt_list_connections(
    state: State<'_, AppState>,
    include_secrets: Option<bool>,
) -> AppResult<Vec<MqttConnection>> {
    state.store.list_mqtt_connections(include_secrets.unwrap_or(false))
}

#[tauri::command]
async fn mqtt_save_connection(
    state: State<'_, AppState>,
    conn: MqttConnection,
) -> AppResult<MqttConnection> {
    state.store.save_mqtt_connection(conn)
}

#[tauri::command]
async fn mqtt_delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.delete_mqtt_connection(&id)
}

#[tauri::command]
async fn dash_panels_list(state: State<'_, AppState>) -> AppResult<Vec<DashPanel>> {
    state.store.list_dash_panels()
}

#[tauri::command]
async fn dash_panel_save(state: State<'_, AppState>, panel: DashPanel) -> AppResult<DashPanel> {
    state.store.save_dash_panel(panel)
}

#[tauri::command]
async fn dash_panel_delete(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.store.delete_dash_panel(&id)
}

// ---------------------------------------------------------------------------
// HMI dashboard: evaluate user-authored parse/publish JS in a sandboxed QuickJS
// runtime. `kind` is "parse" (payload+topic -> object) or "publish" (value ->
// string). Returns `{ ok, out, error }` so the frontend can surface errors
// exactly as before. Running this in Rust means the webview never executes
// `new Function`, so the frontend CSP does not need `unsafe-eval`.
// ---------------------------------------------------------------------------
#[tauri::command]
async fn dash_eval(
    kind: String,
    code: String,
    payload: Option<String>,
    topic: Option<String>,
    value: Option<String>,
) -> AppResult<serde_json::Value> {
    let kind = kind;
    let code = code;
    let payload = payload.unwrap_or_default();
    let topic = topic.unwrap_or_default();
    let value = value.unwrap_or_default();
    let res = tokio::task::spawn_blocking(move || eval_dash_js(&kind, &code, &payload, &topic, &value))
        .await
        .map_err(|e| AppError::Other(format!("dash_eval task join: {e}")))?;
    res
}

fn eval_dash_js(
    kind: &str,
    code: &str,
    payload: &str,
    topic: &str,
    value: &str,
) -> AppResult<serde_json::Value> {
    use rquickjs::{Function as QjsFunction, Runtime as QjsRuntime};

    let rt = QjsRuntime::new().map_err(|e| AppError::Other(format!("QuickJS runtime init: {e}")))?;
    let ctx = QjsContext::full(&rt).map_err(|e| AppError::Other(format!("QuickJS context init: {e}")))?;
    let out = ctx.with(|ctx| {
        // Body starts on line 2 (line 1 is the `function(...)` header), which
        // keeps QuickJS-reported line numbers aligned with the old `new Function`
        // behaviour the frontend's error formatter expects.
        let wrapper = if kind == "publish" {
            format!("(function(value) {{\n{}\n}})", code)
        } else {
            format!("(function(payload, topic) {{\n{}\n}})", code)
        };
        let func: QjsFunction = match ctx.eval(wrapper) {
            Ok(f) => f,
            Err(e) => {
                return serde_json::json!({ "ok": false, "error": format!("函数编译失败: {e}") });
            }
        };
        let js_val = if kind == "publish" {
            // `value` arrives as canonical JSON; rebuild a real JS value from it.
            let v: serde_json::Value = match serde_json::from_str(value) {
                Ok(v) => v,
                Err(e) => {
                    return serde_json::json!({ "ok": false, "error": format!("发布值 JSON 解析失败: {e}") });
                }
            };
            match ctx.json_parse(serde_json::to_string(&v).unwrap_or_else(|_| "null".to_string())) {
                Ok(jv) => jv,
                Err(_) => QjsValue::new_null(ctx.clone()),
            }
        } else {
            match func.call((payload.to_string(), topic.to_string())) {
                Ok(v) => v,
                Err(e) => {
                    return serde_json::json!({ "ok": false, "error": format!("解析函数运行失败: {e}") });
                }
            }
        };
        if kind != "publish" && !js_val.is_object() {
            return serde_json::json!({
                "ok": false,
                "error": "解析函数必须 return 一个对象（如 { temp: 26.3 }）"
            });
        }
        let out_string = if js_val.is_string() {
            js_val.get::<String>().unwrap_or_default()
        } else {
            match ctx.json_stringify(js_val) {
                Ok(Some(s)) => s.get::<String>().unwrap_or_default(),
                _ => return serde_json::json!({ "ok": false, "error": "结果无法序列化为 JSON" }),
            }
        };
        if kind == "publish" {
            serde_json::json!({ "ok": true, "out": out_string })
        } else {
            let parsed: serde_json::Value =
                serde_json::from_str(&out_string).unwrap_or(serde_json::Value::Null);
            serde_json::json!({ "ok": true, "out": parsed })
        }
    });
    Ok(out)
}

pub fn run() {
    // Single-instance guard: if another copy is already running, ask it to raise
    // its window and exit this one. Keeps exactly one process alive (and thus a
    // single desktop-pet overlay). Offline-safe — uses a localhost sentinel port
    // instead of the tauri-plugin-single-instance crate.
    if !crate::single_instance::try_become_primary() {
        crate::single_instance::signal_primary_and_exit();
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
            .setup(|app| {
            // Ensure OS notifications are attributed to this app (not
            // "Windows PowerShell") by registering our Start Menu shortcut +
            // AUMID on Windows. Safe no-op on other platforms / release builds
            // that already ship the shortcut via the installer.
            crate::notify::register_aumid();

            // Single source of truth for the AI approval-reminder state
            // (per-project traffic light + dedup + escalation). Must be created
            // before any approval event can arrive (the HOOK listener below, or
            // the legacy scan path during a session).
            crate::perm_aggregator::init(app.handle().clone());

            let data_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => return Err(format!("cannot resolve app data dir: {e}").into()),
            };
            crate::perm_hook::debug_log("setup: before Store::new");
            let store = match Store::new(&data_dir) {
                Ok(s) => s,
                Err(e) => {
                    crate::perm_hook::debug_log(&format!("setup: Store::new FAILED: {e}"));
                    return Err(format!("store init failed: {e}").into());
                }
            };
            crate::perm_hook::debug_log("setup: store ok");
            crate::perm_hook::debug_log(&format!("setup: data_dir={}", data_dir.display()));

            // Let the single-instance listener thread raise this window if a
            // second launch pings us.
            crate::single_instance::set_app_handle(app.handle().clone());

            // Start the approval-HOOK listener right away, reading the persisted
            // settings (enabled / port). This makes the listener independent of
            // frontend timing — previously it was only started by a frontend
            // effect, so a stale build or a frontend that never ran the effect
            // left approval hooks POSTing into a dead port.
            match store.get_settings() {
                Ok(settings) => {
                    let approval = settings
                        .get("approval")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!({}));
                    let enabled = approval
                        .get("enabled")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true);
                    let port = approval
                        .get("port")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(47890) as u16;
                    // Build the set of tools the user wants managed from the
                    // persisted approval.tools flags; self-heal re-asserts their
                    // hooks (with the actual port) on every launch so an install
                    // survives a restart.
                    let managed: Vec<String> = approval
                        .get("tools")
                        .and_then(|t| t.as_object())
                        .map(|o| {
                            o.iter()
                                .filter(|(_, v)| v.as_bool() == Some(true))
                                .map(|(k, _)| k.clone())
                                .collect()
                        })
                        // `.tools` missing (e.g. a fresh DB before the first
                        // settings save) → manage all three, matching
                        // DEFAULT_SETTINGS.approval.tools, so the hook self-heal
                        // still runs on the very first launch.
                        .unwrap_or_else(|| vec!["claude".into(), "codex".into(), "opencode".into()]);
                    crate::perm_hook::debug_log(&format!(
                        "setup: approval={approval} enabled={enabled} port={port} managed={managed:?}"
                    ));
                    if enabled && port > 0 {
                        // block_on (not spawn): guarantees the listener starts
                        // before setup returns, immune to task-scheduling quirks.
                        let r = tauri::async_runtime::block_on(
                            crate::perm_hook::perm_hook_start(port, Some(managed)),
                        );
                        crate::perm_hook::debug_log(&format!(
                            "setup: listener start result {r:?}"
                        ));
                    }
                }
                Err(e) => {
                    crate::perm_hook::debug_log(&format!("setup: get_settings failed: {e}"));
                }
            }

            let store = Arc::new(store);
            app.manage(AppState {
                ssh: SshManager::new(store.clone()),
                serial: SerialManager::default(),
                protocol: ProtocolManager::new(store.clone()),
                ble: BleManager::default(),
                mqtt: MqttManager::default(),
                pty: PtyManager::default(),
                forward: PortForwardManager::new(store.clone()),
                store: store.clone(),
                metrics: MetricsCache::default(),
                local: LocalMonitor::new(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // User asked the OS to close the main window. We need to know
            // *before* it tears down whether to prompt, so peek the
            // `confirmOnExit` setting here. Reading the store synchronously
            // is fine — it's a tiny in-memory struct.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let confirm = window
                        .app_handle()
                        .try_state::<crate::storage::Store>()
                        .map(|s| {
                            s.get_settings()
                                .ok()
                                .and_then(|v| v.get("confirmOnExit").and_then(|x| x.as_bool()))
                                .unwrap_or(true)
                        })
                        .unwrap_or(true);
                    if confirm {
                        // Block this close; the frontend will show the
                        // confirmation dialog and, on accept, call
                        // `app_exit` to actually terminate the process.
                        api.prevent_close();
                        let _ = window.app_handle().emit("confirm-exit", ());
                    }
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                // The pet is an always-on-top, skip-taskbar overlay window. If the
                // user closes the main window we must also tear the pet down,
                // otherwise it keeps the process alive — and every re-launch would
                // then spawn a *second* pet. Closing the main window therefore
                // exits the whole app (the pet is the last window left).
                if window.label() != "pet" {
                    if let Some(pet) = window.app_handle().get_webview_window("pet") {
                        let _ = pet.destroy();
                    }
                }
                // Tear every live session down cleanly so remote shells don't linger.
                if let Some(state) = window.try_state::<AppState>() {
                    state.serial.close_all();
                    state.ble.close_all();
                    state.mqtt.close_all();
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
            ssh_forward_list,
            ssh_forward_start,
            ssh_forward_stop,
            ssh_forward_save,
            ssh_forward_delete,
            ssh_forward_rules,
            ssh_known_hosts_list,
            ssh_known_hosts_remove,
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
            sftp_read_bytes,
            sftp_set_perms,
            mqtt_connect,
            mqtt_disconnect,
            mqtt_publish,
            mqtt_subscribe,
            mqtt_unsubscribe,
            mqtt_list_connections,
            mqtt_save_connection,
            mqtt_delete_connection,
            dash_panels_list,
            dash_panel_save,
            dash_panel_delete,
            dash_eval,
            remote_metrics,
            local_metrics,
            serial_list_ports,
            serial_baud_rates,
            serial_open,
            serial_write,
            serial_signals,
            serial_close,
            serial_attach,
            protocol_list,
            protocol_save,
            protocol_load,
            protocol_delete,
            protocol_duplicate,
            protocol_parse,
            protocol_validate,
            protocol_encode,
            protocol_loopback_open,
            protocol_loopback_send,
            protocol_loopback_reload,
            protocol_loopback_close,
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
            ai_cancel,
            ai_clear_inflight,
            notify_show,
            set_approval_notifications,
            set_scan_fallback,
            perm_state,
            perm_ack,
            set_global_approve_shortcut,
            perm_hook::perm_hook_start,
            perm_hook::perm_hook_stop,
            perm_hook::perm_hook_install,
            perm_hook::perm_hook_uninstall,
            perm_hook::perm_hook_status,
            fonts::list_fonts,
            fonts::import_font,
            fonts::list_imported_fonts,
            fonts::read_font,
            kb::kb_scan,
            kb::kb_read,
            local_fs::local_home,
            local_fs::local_list,
            local_fs::local_mkdir,
            local_fs::local_remove,
            local_fs::local_rename,
            local_fs::reveal_path,
            local_fs::open_path,
            local_fs::open_url,
            local_fs::local_write_text,
            git::git_snapshot,
            git::git_status,
            git::git_branches,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_checkout,
            git::git_new_branch,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_diff,
            git::git_log,
            git::git_commit_diff,
            git::git_reset,
            git::git_checkout_commit,
            docker::docker_available,
            docker::docker_ps,
            docker::docker_images,
            docker::docker_start,
            docker::docker_stop,
            docker::docker_restart,
            docker::docker_remove,
            docker::docker_rmi,
            docker::docker_pull,
            docker::docker_logs,
            docker::docker_run,
            docker::docker_compose,
            jlink::jlink_available,
            jlink::jlink_connect,
            jlink::jlink_status,
            jlink::jlink_disconnect,
            jlink::jlink_reset,
            jlink::jlink_read_mem,
            jlink::jlink_write_mem,
            jlink::jlink_erase,
            jlink::jlink_program,
            jlink::jlink_gdb_start,
            jlink::jlink_gdb_stop,
            jlink::jlink_gdb_running,
            jlink::jlink_rtt_start,
            jlink::jlink_rtt_stop,
            jlink::jlink_rtt_running,
            jlink::jlink_rtt_send,
            jlink::jlink_launch_tool,
            app_exit,
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
