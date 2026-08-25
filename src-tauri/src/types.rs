use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    Ssh,
    Serial,
    Local,
    Wsl,
    Frp,
}

impl HostKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            HostKind::Ssh => "ssh",
            HostKind::Serial => "serial",
            HostKind::Local => "local",
            HostKind::Wsl => "wsl",
            HostKind::Frp => "frp",
        }
    }
    pub fn from_str(s: &str) -> Self {
        match s {
            "serial" => HostKind::Serial,
            "local" => HostKind::Local,
            "wsl" => HostKind::Wsl,
            "frp" => HostKind::Frp,
            _ => HostKind::Ssh,
        }
    }
}

/// A saved connection. Covers both SSH and Serial; irrelevant fields stay None.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub name: String,
    pub kind: HostKind,

    // --- SSH ---
    #[serde(default)]
    pub hostname: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: Option<String>,
    /// Never returned to the frontend in list queries unless explicitly asked.
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub save_password: bool,

    // --- Serial ---
    #[serde(default)]
    pub serial_port: Option<String>,
    #[serde(default)]
    pub baud_rate: Option<u32>,
    #[serde(default)]
    pub data_bits: Option<u8>,
    #[serde(default)]
    pub stop_bits: Option<u8>,
    /// "none" | "odd" | "even"
    #[serde(default)]
    pub parity: Option<String>,
    /// "none" | "software" | "hardware"
    #[serde(default)]
    pub flow_control: Option<String>,

    // --- WSL ---
    /// Distro name as reported by `wsl -l -v`. None = WSL's default distro.
    #[serde(default)]
    pub wsl_distro: Option<String>,
    /// Linux user to run as (`wsl --user`). None = the distro's default user.
    #[serde(default)]
    pub wsl_user: Option<String>,
    /// Starting directory inside the distro (`wsl --cd`).
    #[serde(default)]
    pub wsl_cwd: Option<String>,

    // --- Frp ---
    /// JSON-encoded `FrpConfig` (server + proxies). Stored as text so the
    /// schema stays stable even when the config model evolves.
    #[serde(default)]
    pub frp_config: Option<String>,

    // --- Meta ---
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub last_used: Option<i64>,
    #[serde(default)]
    pub created_at: Option<i64>,
    /// Last write time (unix seconds). Kept for export/import and future sync
    /// (last-write-wins merge).
    #[serde(default)]
    pub updated_at: Option<i64>,

    /// OS distribution id for the host-list icon (e.g. "ubuntu", "debian").
    /// None = auto / generic Linux.
    #[serde(default)]
    pub distro: Option<String>,
}

// ---------------------------------------------------------------------------
// SSH
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectConfig {
    /// Optional: reuse an existing saved host id as the session id prefix.
    #[serde(default)]
    pub host_id: Option<String>,
    pub hostname: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u32,
    #[serde(default = "default_rows")]
    pub rows: u32,
    #[serde(default = "default_term")]
    pub term: String,
    /// When true, a new/changed host key is trusted (written to known_hosts)
    /// instead of aborting the connection. Set by the UI after the user
    /// explicitly accepts an unknown/mismatched host key.
    #[serde(default)]
    pub trust_host_key: bool,
}

fn default_port() -> u16 {
    22
}
fn default_cols() -> u32 {
    120
}
fn default_rows() -> u32 {
    32
}
fn default_term() -> String {
    "xterm-256color".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectResult {
    pub session_id: String,
    pub server_key_fingerprint: String,
    pub home_dir: String,
    /// The remote login shell (e.g. "/bin/bash", "fish", "/bin/zsh"), probed
    /// at connect time. The frontend uses it to pick the right OSC 7 emitter so
    /// the cwd bar / Git panel track `cd` correctly — guessing "bash" breaks
    /// for fish/sh/dash remotes where the bash-specific hook never fires.
    #[serde(default)]
    pub shell: String,
    /// Host-key verification outcome: "verified" (known + matching),
    /// "replaced" (newly trusted or overwritten on `trustHostKey`), or
    /// "unknown" / "mismatch" (connection aborted; the UI shows a prompt).
    #[serde(default)]
    pub host_key_status: String,
}

// ---------------------------------------------------------------------------
// SSH port forwarding
// ---------------------------------------------------------------------------

/// Direction of a port forward, mirroring `ssh` `-L` / `-R` / `-D`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ForwardType {
    /// `-L` local: listen locally, tunnel to a remote target over SSH.
    Local,
    /// `-R` remote: the server listens, tunnels inbound connections back to a
    /// local target on this machine.
    Remote,
    /// `-D` dynamic: a local SOCKS5 proxy; the target is chosen per connection.
    Dynamic,
}

impl ForwardType {
    pub fn as_str(self) -> &'static str {
        match self {
            ForwardType::Local => "local",
            ForwardType::Remote => "remote",
            ForwardType::Dynamic => "dynamic",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRule {
    pub id: String,
    /// Saved host this rule belongs to (so it survives reconnects).
    pub host_id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub forward_type: ForwardType,
    /// Local bind address (local/dynamic) or the server bind address (remote).
    #[serde(default = "default_local_host")]
    pub local_host: String,
    /// Local bind port (local/dynamic) or the local target port (remote).
    pub local_port: u16,
    /// Remote target host (local) or the server bind address (remote). Ignored
    /// for dynamic forwards.
    #[serde(default)]
    pub remote_host: String,
    /// Remote target port (local) or the server bind port (remote).
    #[serde(default)]
    pub remote_port: u16,
    /// Start automatically when a session for `host_id` connects.
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub sort_order: i64,
    /// Last write time (unix seconds).
    #[serde(default)]
    pub updated_at: Option<i64>,
}

fn default_local_host() -> String {
    "127.0.0.1".into()
}

/// Live status of a running (or failed) forward, returned to the frontend.
///
/// `status` is derived from a *confirmed* real listener / server-forward result
/// (never from a button click), following the Netcatty port-forward runtime
/// model: active must mean a TCP port is actually bound or the server confirmed
/// the forward.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardStatus {
    pub id: String,
    /// "connecting" | "active" | "error" | "inactive"
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    /// The actual bound port (useful when `local_port` was 0 / dynamic).
    #[serde(default)]
    pub bound_port: Option<u16>,
}

/// One trusted host-key entry from the known_hosts store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub first_seen: i64,
    pub last_seen: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix mtime in seconds.
    pub modified: u64,
    /// Octal-ish permission bits, e.g. 0o755.
    pub permissions: u32,
    pub owner: Option<String>,
    pub group: Option<String>,
}

/// Detailed metadata for a single remote file — used by the permission editor
/// and the resumable-transfer stat call. (`RemoteFile` is the directory-listing
/// shape; this is the richer per-file probe.)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileMeta {
    pub path: String,
    pub size: u64,
    pub permissions: u32,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub modified: u64,
}

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMetrics {
    pub hostname: String,
    pub os: String,
    pub kernel: String,
    pub uptime_secs: u64,
    pub cpu_percent: f32,
    pub cpu_cores: u32,
    pub load_avg: [f32; 3],
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub swap_total_kb: u64,
    pub swap_used_kb: u64,
    pub disks: Vec<DiskUsage>,
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
    pub temperature_c: Option<f32>,
    pub processes: Vec<ProcessInfo>,
    /// Milliseconds since epoch, sampled on the backend.
    pub sampled_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub mount: String,
    pub total_kb: u64,
    pub used_kb: u64,
    pub fs: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub mem_kb: u64,
}

// ---------------------------------------------------------------------------
// Serial
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortInfo {
    pub name: String,
    /// "usb" | "pci" | "bluetooth" | "unknown"
    pub kind: String,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialOpenConfig {
    #[serde(default)]
    pub host_id: Option<String>,
    pub port: String,
    #[serde(default = "default_baud")]
    pub baud_rate: u32,
    #[serde(default = "default_data_bits")]
    pub data_bits: u8,
    #[serde(default = "default_stop_bits")]
    pub stop_bits: u8,
    #[serde(default = "default_parity")]
    pub parity: String,
    #[serde(default = "default_flow")]
    pub flow_control: String,
}

fn default_baud() -> u32 {
    115_200
}
fn default_data_bits() -> u8 {
    8
}
fn default_stop_bits() -> u8 {
    1
}
fn default_parity() -> String {
    "none".into()
}
fn default_flow() -> String {
    "none".into()
}

// ---------------------------------------------------------------------------
// Bluetooth Low Energy
// ---------------------------------------------------------------------------

/// One peripheral seen during a BLE discovery window.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleDeviceInfo {
    /// btleplug's per-adapter handle id — what `ble_open` expects.
    pub id: String,
    /// Advertised local name; empty for nameless beacons.
    pub name: String,
    pub address: String,
    /// Signal strength in dBm, when the backend reports one.
    pub rssi: Option<i16>,
    /// Advertised service UUIDs, lowercase 128-bit form.
    pub services: Vec<String>,
    pub connected: bool,
}

/// GATT serial-bridge profile plus the target device.
///
/// UUIDs accept 16-bit ("FFE0" / "0xFFE0"), 32-bit or full 128-bit forms.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BleOpenConfig {
    #[serde(default)]
    pub host_id: Option<String>,
    pub device_id: String,
    #[serde(default)]
    pub device_name: Option<String>,
    pub service: String,
    /// Host -> device characteristic.
    pub write_characteristic: String,
    /// Device -> host characteristic. Omit for a write-only link.
    #[serde(default)]
    pub notify_characteristic: Option<String>,
    /// Bytes per GATT write; defaults to the 20-byte unnegotiated ATT payload.
    #[serde(default)]
    pub chunk_size: Option<usize>,
}

// ---------------------------------------------------------------------------
// Quick commands / settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    pub id: String,
    pub name: String,
    pub value: String,
    /// "ssh" | "serial" | "both"
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default)]
    pub is_hex: bool,
    #[serde(default)]
    pub sort_order: i64,
    /// Last write time (unix seconds). Kept for export/import and future sync.
    #[serde(default)]
    pub updated_at: Option<i64>,
}

fn default_scope() -> String {
    "both".into()
}

/// Payload streamed to the frontend for terminal / serial output.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunk {
    pub session_id: String,
    /// base64-encoded raw bytes — keeps binary and invalid-UTF8 data intact.
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClosed {
    pub session_id: String,
    pub reason: String,
    pub exit_code: Option<u32>,
    /// PTY-only: `true` when the console (ConPTY) I/O pipe broke while the
    /// shell process is *still running* — e.g. a child TUI (OpenCode, …) torn
    /// down by a rapid double Ctrl+C can take the whole pseudoconsole with it,
    /// orphaning the shell. The session is unrecoverable; the UI should restart
    /// the shell in place instead of showing a fatal "connection closed" state.
    #[serde(default)]
    pub restart: Option<bool>,
}

/// Fired by the backend when a vibecoding CLI (Claude Code, Codex, …) appears to
/// be waiting for the user to approve an action.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermRequest {
    pub session_id: String,
    /// Human label of the tool that is asking (e.g. "Claude Code").
    pub tool: String,
    /// The prompt text / command we captured (ANSI stripped, truncated).
    pub snippet: String,
    /// Unix epoch millis when the prompt was detected.
    pub ts: u64,
    /// Where the detection came from:
    ///   - `"hook"` — the tool's own permission hook/plugin fired (exact, no
    ///     false positives; this is the primary path).
    ///   - `"scan"` — legacy terminal-output regex scan (opt-in compatibility).
    pub source: String,
    /// Project directory the agent is operating in, when known (drives the
    /// per-project traffic-light grouping on the frontend).
    #[serde(default)]
    pub cwd: Option<String>,
}

// ---------------------------------------------------------------------------
// MQTT (ported MQTTX-style functionality)
// ---------------------------------------------------------------------------

/// Connection parameters for opening a live MQTT session. `hostId` links back to
/// a saved connection so the backend can resolve a sealed password (`__saved__`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttConnectConfig {
    pub name: String,
    /// "mqtt" | "mqtts" | "ws" | "wss".
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub client_id: String,
    pub username: Option<String>,
    pub password: Option<String>,
    /// Saved-connection id, used to reveal a sealed password when `password`
    /// is the `__saved__` sentinel.
    pub host_id: Option<String>,
    pub clean: bool,
    /// Seconds between keep-alive pings.
    pub keep_alive: u16,
    pub connect_timeout: u16,
    pub reconnect: bool,
    /// WebSocket request path (e.g. "/mqtt"); only used for ws/wss.
    pub path: String,
    /// Skip TLS certificate / hostname verification (self-signed brokers).
    pub insecure_skip_verify: bool,
}

/// A single persisted subscription on a connection.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MqttStoredSub {
    pub topic: String,
    pub qos: u8,
}

/// Persisted publish settings for a connection (so the publish form is
/// restored on reconnect / on another synced device).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MqttPublishPref {
    #[serde(default)]
    pub topic: String,
    #[serde(default)]
    pub qos: u8,
    #[serde(default)]
    pub retain: bool,
    /// Last payload (kept for convenience; may be empty).
    #[serde(default)]
    pub payload: String,
}

/// A persisted MQTT connection profile. Mirrors MQTTX's connection model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttConnection {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub client_id: String,
    pub username: Option<String>,
    /// `"__saved__"` means a credential exists in the encrypted vault.
    pub password: Option<String>,
    pub save_password: bool,
    pub clean: bool,
    pub keep_alive: u16,
    pub connect_timeout: u16,
    pub reconnect: bool,
    pub path: String,
    pub insecure_skip_verify: bool,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    /// Persisted subscriptions (None → leave whatever is stored untouched).
    #[serde(default)]
    pub subscriptions: Option<Vec<MqttStoredSub>>,
    /// Persisted publish form (None → leave whatever is stored untouched).
    #[serde(default)]
    pub publish: Option<MqttPublishPref>,
}

/// A single inbound or outbound MQTT packet, streamed to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttMessage {
    /// Backend session id (event suffix), not the MQTT client id.
    pub id: String,
    pub topic: String,
    /// Raw payload as base64 (binary-safe; frontend decodes to utf8/hex).
    pub payload_base64: String,
    pub qos: u8,
    pub retain: bool,
    /// "in" (received) or "out" (published by us).
    pub direction: String,
    pub timestamp: i64,
}

/// Connection lifecycle event streamed to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttStatus {
    pub id: String,
    /// "connecting" | "connected" | "reconnecting" | "error" | "disconnected".
    pub status: String,
    pub detail: Option<String>,
}

/// A user-built smart-home / HMI dashboard panel ("上位机"). The full layout
/// (widgets, grid, background) is stored as an opaque JSON blob in `json` so
/// the frontend owns the schema and can evolve it without a DB migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashPanel {
    pub id: String,
    pub name: String,
    pub connection_id: String,
    /// Denormalised display name of the MQTT connection (sync on save).
    pub connection_name: String,
    /// JSON: { cols, widgets: [...], background: {...} }
    pub json: String,
    pub sort_order: i64,
    pub updated_at: i64,
}
