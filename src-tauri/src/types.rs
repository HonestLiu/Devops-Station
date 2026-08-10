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
}
