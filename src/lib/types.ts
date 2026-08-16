export type HostKind = "ssh" | "serial" | "local" | "wsl" | "frp";

/** A single terminal keyword-highlight rule. Matched case-insensitively. */
export interface KeywordHighlightRule {
  /** Stable id for editing / removal. */
  id: string;
  /** Regex source (no delimiters / flags). */
  pattern: string;
  /** #RRGGBB color. */
  color: string;
  /** Tint the whole line background (else only the scrollbar marker is shown). */
  wholeLine?: boolean;
  enabled: boolean;
}

/** Global keyword-highlight configuration (per-host rules merge on top). */
export interface KeywordHighlightSettings {
  enabled: boolean;
  rules: KeywordHighlightRule[];
}

/** Known OS distributions for the host-list icon (see `DISTROS` in DistroIcon). */
export type DistroId =
  | "ubuntu"
  | "debian"
  | "centos"
  | "fedora"
  | "arch"
  | "alpine"
  | "amazon"
  | "redhat"
  | "rocky"
  | "opensuse"
  | "oracle"
  | "kali"
  | "almalinux"
  | "rhel"
  | "linux";

export interface Host {
  id: string;
  name: string;
  kind: HostKind;
  hostname?: string | null;
  port?: number | null;
  username?: string | null;
  /** `"__saved__"` means a credential exists in the encrypted store. */
  password?: string | null;
  privateKeyPath?: string | null;
  passphrase?: string | null;
  savePassword: boolean;
  serialPort?: string | null;
  baudRate?: number | null;
  dataBits?: number | null;
  stopBits?: number | null;
  parity?: string | null;
  flowControl?: string | null;
  /** WSL distro name; empty/null means WSL's own default distro. */
  wslDistro?: string | null;
  /** Linux user to run as (`wsl --user`). */
  wslUser?: string | null;
  /** Starting directory inside the distro (`wsl --cd`). */
  wslCwd?: string | null;
  /** JSON-encoded FrpConfig (server + proxies). */
  frpConfig?: string | null;
  color?: string | null;
  tags: string[];
  lastUsed?: number | null;
  createdAt?: number | null;
  /** Last write time (unix seconds) — used by export/import and future sync. */
  updatedAt?: number | null;
  /** Per-host keyword-highlight rules (merged with the global settings). */
  keywordRules?: KeywordHighlightRule[] | null;
  /** Whether this host uses keyword highlighting. null = follow the global toggle. */
  keywordEnabled?: boolean | null;
  /** OS distribution id for the host-list icon (e.g. "ubuntu", "debian", "centos"). null = auto/generic. */
  distro?: string | null;
}

export interface SshConnectConfig {
  hostId?: string;
  hostname: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  cols: number;
  rows: number;
  term: string;
  /** Trust an unknown/changed host key and proceed (set after the user
   *  explicitly accepts a host-key prompt). */
  trustHostKey?: boolean;
}

export interface SshConnectResult {
  sessionId: string;
  serverKeyFingerprint: string;
  homeDir: string;
  /** "verified" | "replaced" (newly trusted / overwritten). */
  hostKeyStatus?: string;
}

/** SSH port-forward direction: local (-L), remote (-R), dynamic (-D). */
export type ForwardType = "local" | "remote" | "dynamic";

export interface PortForwardRule {
  id: string;
  hostId: string;
  name: string;
  type: ForwardType;
  /** Local bind address (local/dynamic) or server bind address (remote). */
  localHost: string;
  localPort: number;
  /** Remote target host (local) or server bind address (remote). */
  remoteHost: string;
  remotePort: number;
  autoStart?: boolean;
  sortOrder?: number;
  updatedAt?: number | null;
}

export interface PortForwardStatus {
  id: string;
  /** "connecting" | "active" | "error" | "inactive" */
  status: string;
  error?: string | null;
  /** The actually-bound port (useful when localPort was 0). */
  boundPort?: number | null;
}

export interface KnownHostEntry {
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  firstSeen: number;
  lastSeen: number;
}

export interface RemoteFile {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number;
  permissions: number;
  owner?: string | null;
  group?: string | null;
}

/** Detailed probe of a single remote file (permission editor + resume stat). */
export interface RemoteFileMeta {
  path: string;
  size: number;
  permissions: number;
  owner?: string | null;
  group?: string | null;
  modified: number;
}

/** A local directory listing entry (dual-pane SFTP tab, right pane). */
export interface LocalEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface DiskUsage {
  mount: string;
  totalKb: number;
  usedKb: number;
  fs: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memKb: number;
}

export interface HostMetrics {
  hostname: string;
  os: string;
  kernel: string;
  uptimeSecs: number;
  cpuPercent: number;
  cpuCores: number;
  loadAvg: [number, number, number];
  memTotalKb: number;
  memUsedKb: number;
  swapTotalKb: number;
  swapUsedKb: number;
  disks: DiskUsage[];
  /** Bytes per second, computed from consecutive samples. */
  netRxBytes: number;
  netTxBytes: number;
  temperatureC?: number | null;
  processes: ProcessInfo[];
  sampledAt: number;
}

export interface SerialPortInfo {
  name: string;
  kind: "usb" | "pci" | "bluetooth" | "unknown";
  manufacturer?: string | null;
  product?: string | null;
  serialNumber?: string | null;
  vid?: number | null;
  pid?: number | null;
}

export interface SerialOpenConfig {
  hostId?: string;
  port: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: "none" | "odd" | "even";
  flowControl: "none" | "software" | "hardware";
}

/** One peripheral seen during a BLE discovery window. */
export interface BleDeviceInfo {
  /** Backend handle id — pass this to `ble.open`. */
  id: string;
  /** Advertised local name; empty for nameless beacons. */
  name: string;
  address: string;
  /** Signal strength in dBm when the adapter reports one. */
  rssi?: number | null;
  services: string[];
  connected: boolean;
}

/**
 * GATT serial-bridge profile plus target device. UUIDs accept 16-bit ("FFE0"),
 * 32-bit or full 128-bit forms — see `lib/bleGatt.ts`.
 */
export interface BleOpenConfig {
  hostId?: string;
  deviceId: string;
  deviceName?: string;
  service: string;
  /** Host -> device characteristic. */
  writeCharacteristic: string;
  /** Device -> host characteristic; omit for a write-only link. */
  notifyCharacteristic?: string;
  /** Bytes per GATT write; defaults to the 20-byte unnegotiated ATT payload. */
  chunkSize?: number;
}

export interface QuickCommand {
  id: string;
  name: string;
  value: string;
  scope: "ssh" | "serial" | "both";
  isHex: boolean;
  sortOrder: number;
  /** Last write time (unix seconds) — used by export/import and future sync. */
  updatedAt?: number | null;
}

export interface StreamChunk {
  sessionId: string;
  /** base64 */
  data: string;
}

export interface SessionClosed {
  sessionId: string;
  reason: string;
  exitCode?: number | null;
}

/**
 * Result of the attach handshake: everything the session produced between
 * being spawned and the terminal getting its event listener registered.
 */
export interface Attached {
  /** base64 of the buffered bytes — write these before any live chunk. */
  backlog: string;
  /** Present when the session already died before the UI attached. */
  closed?: SessionClosed | null;
}

export interface TransferProgress {
  transferId: string;
  fileName: string;
  transferred: number;
  total: number;
  done: boolean;
  error?: string | null;
}

// --- UI-only models --------------------------------------------------------

export type ThemeId =
  | "tokyo-night"
  | "dark"
  | "light"
  | "nord"
  | "dracula"
  | "one-dark"
  | "github-dark"
  | "gruvbox"
  | "monokai"
  | "solarized-light"
  | "catppuccin-latte";

export type TabKind = "ssh" | "serial" | "ble" | "local" | "wsl" | "frp" | "sftp" | "jlink" | "mqtt";

export type TabStatus = "connecting" | "connected" | "closed" | "error";

/** One terminal in a split-pane tab. The first pane mirrors the tab itself. */
export interface TermPane {
  id: string;
  sessionId?: string;
  status: TabStatus;
  error?: string;
}

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  subtitle: string;
  status: TabStatus;
  /** Backend session id of the FOCUSED pane; absent while connecting. */
  sessionId?: string;
  hostId?: string;
  error?: string;
  /** SSH / Local — current working directory (local is kept fresh via OSC 7). */
  cwd?: string;
  /** Local only — the resolved shell that was launched (e.g. "pwsh.exe",
   *  "/bin/zsh", "fish"). Stored so the OSC 7 emitter and Reconnect both use
   *  the exact same shell the backend spawned. */
  shell?: string;
  fingerprint?: string;
  /** Serial only */
  serial?: SerialOpenConfig;
  /** BLE only — the GATT profile + device, kept so Reconnect can re-open it. */
  ble?: BleOpenConfig;
  /** WSL only — kept so Reconnect can respawn with the same distro/user. */
  wsl?: WslLaunchConfig;
  /** Frp only — kept so Reconnect can respawn the same tunnel. */
  frp?: FrpLaunchConfig;
  /** SFTP-only tab — the underlying SSH connect config, kept for Reconnect. */
  sftpConfig?: SshConnectConfig;
  /** J-Link only — the probe config kept so Reconnect/Duplicate can reopen. */
  jlink?: JLinkConfig;
  /** SSH only — cached credentials/config so Reconnect and Split can reconnect. */
  sshConfig?: SshConnectConfig;
  /** MQTT only — the saved connection profile backing this live session. */
  mqtt?: MqttConnection;
  /** Split panes (2/4 terminals in one tab). Undefined = single terminal. */
  panes?: TermPane[];
  /** Which pane is focused (used for split keyboard nav + shared sessionId). */
  focusedPaneId?: string;
  /** 2-pane split orientation: "col" = side by side, "row" = stacked. */
  splitAxis?: "col" | "row";
  /**
   * Split-group id: tabs sharing the same id render side-by-side in one view
   * (drag a tab onto another in the tab bar). Setting it to undefined detaches
   * the tab back into a standalone view — the underlying session is untouched,
   * so "closing" a split member just un-groups it.
   */
  group?: string;
}

// --- MQTT (ported MQTTX-style functionality) --------------------------------

export type MqttProtocol = "mqtt" | "mqtts" | "ws" | "wss";

/** A persisted MQTT connection profile (mirrors MQTTX's connection model). */
export interface MqttConnection {
  id: string;
  name: string;
  protocol: MqttProtocol;
  host: string;
  port: number;
  clientId: string;
  username?: string | null;
  /** "__saved__" means a credential exists in the encrypted store. */
  password?: string | null;
  savePassword: boolean;
  clean: boolean;
  keepAlive: number;
  connectTimeout: number;
  reconnect: boolean;
  path: string;
  insecureSkipVerify: boolean;
  createdAt?: number | null;
  updatedAt?: number | null;
  /** Persisted subscriptions (restored on reconnect / on other synced devices). */
  subscriptions?: { topic: string; qos: number }[];
  /** Persisted publish form. */
  publish?: { topic: string; qos: number; retain: boolean; payload: string };
}

/** Parameters for opening a live MQTT session. */
export interface MqttConnectConfig {
  name: string;
  protocol: MqttProtocol;
  host: string;
  port: number;
  clientId: string;
  username?: string | null;
  password?: string | null;
  /** Saved-connection id, used to reveal a sealed password. */
  hostId?: string | null;
  clean: boolean;
  keepAlive: number;
  connectTimeout: number;
  reconnect: boolean;
  path: string;
  insecureSkipVerify: boolean;
}

/** A single inbound or outbound MQTT packet, streamed from the backend. */
export interface MqttMessage {
  id: string;
  topic: string;
  /** Raw payload as base64 (binary-safe; decode to utf8/hex on display). */
  payloadBase64: string;
  qos: number;
  retain: boolean;
  direction: "in" | "out";
  timestamp: number;
}

/** Connection lifecycle event streamed from the backend. */
export interface MqttStatus {
  id: string;
  status: "connecting" | "connected" | "reconnecting" | "error" | "disconnected";
  detail?: string | null;
}

/** One installed WSL distribution, from `wsl -l -v`. */
export interface WslDistro {
  name: string;
  /** "Running" | "Stopped" — localized on non-English Windows. */
  state: string;
  /** WSL major version: "1" or "2". */
  version: string;
  isDefault: boolean;
}

export interface WslLaunchConfig {
  hostId?: string;
  /** Empty/undefined launches WSL's default distro. */
  distro?: string;
  user?: string;
  cwd?: string;
}

// --- WSL USB Device Manager (usbipd-win) ---------------------------------

export type UsbCategory = "USB Serial" | "Debug Probe" | "MCU Dev Board" | "USB-JTAG";

/** Coarse lifecycle status of a USB device. */
export type UsbDeviceStatus =
  | "Available"
  | "Bound"
  | "Connected"
  | "Connecting"
  | "Error";

/** A USB device as returned by the Rust backend (`usbip_list`). */
export interface UsbDevice {
  busid: string;
  vid: string;
  pid: string;
  /** Raw Windows device name. */
  name: string;
  /** Friendly, human-readable name (e.g. "ESP32-S3 Dev Board"). */
  friendly_name: string;
  category: UsbCategory;
  status: "Available" | "Bound" | "Connected";
  /** Whether the device is currently attached into WSL. */
  wsl_attached: boolean;
  /** Detected Linux serial ports (e.g. "/dev/ttyACM0") after attach. */
  serial_ports: string[];
}

/** Verification result after attach (`lsusb` + serial port probe). */
export interface UsbVerify {
  attached: boolean;
  serial_ports: string[];
  lsusb: string;
  /** Optional note (e.g. fallback explanation) from the backend. */
  note?: string;
}

/** Embeddev-specific quick actions surfaced on a device card. */
export interface UsbAction {
  label: string;
  /** Event name emitted to other panels (e.g. the future Serial Terminal). */
  event: string;
  /** Optional payload (e.g. serial port for "Open Serial"). */
  port?: string;
}

// --- Frp (fast reverse proxy) ----------------------------------------------

export type FrpProxyType = "tcp" | "udp" | "http" | "https" | "tcpmux" | "stcp" | "xtcp";

export interface FrpProxy {
  name: string;
  type: FrpProxyType;
  localIp: string;
  localPort: number;
  remotePort?: number | null;
  customDomain?: string | null;
  /** Comma-separated list for HTTP/HTTPS virtual hosts. */
  customDomains?: string | null;
  subdomain?: string | null;
  locations?: string | null;
  useEncryption?: boolean | null;
  useCompression?: boolean | null;
  proxyProtocolVersion?: string | null;
  bandwidthLimit?: string | null;
  group?: string | null;
  groupKey?: string | null;
  healthCheckType?: string | null;
  healthCheckUrl?: string | null;
  healthCheckIntervalS?: number | null;
  healthCheckMaxFailed?: number | null;
  healthCheckTimeoutS?: number | null;
  /** Escape hatch for any field not modelled above. */
  extra?: Record<string, string> | null;
}

export interface FrpServer {
  serverAddr: string;
  serverPort: number;
  token?: string | null;
  user?: string | null;
  tlsEnable?: boolean | null;
  protocol?: string | null;
  proxyUrl?: string | null;
  dnsServer?: string | null;
  heartbeatInterval?: number | null;
  heartbeatTimeout?: number | null;
  loginFailExit?: boolean | null;
  logLevel?: string | null;
  logToFile?: boolean | null;
  disableCustomTls?: boolean | null;
  sniServerName?: string | null;
  tlsTrustedCaFile?: string | null;
}

export interface FrpConfig {
  server?: FrpServer | null;
  proxies: FrpProxy[];
}

export interface FrpLaunchConfig {
  hostId?: string;
  /** Full config; reconnection simply re-spawns frpc with the same toml. */
  config: FrpConfig;
}

export type SerialViewMode = "normal" | "terminal" | "plot";

export type SerialEncoding = "utf-8" | "gbk" | "ascii" | "hex";

export type LineEnding = "none" | "cr" | "lf" | "crlf";

export interface SerialLogEntry {
  id: number;
  at: number;
  dir: "rx" | "tx";
  text: string;
  hex: string;
}

// --- AI Assistant --------------------------------------------------------------

export type AIProviderKind = "openai" | "ollama" | "custom";

/** Per-tool approval-notification toggles (driven by installed permission hooks). */
export interface ApprovalHookTools {
  /** Claude Code (`~/.claude/settings.json` hooks). */
  claude: boolean;
  /** OpenAI Codex (`~/.codex/hooks.json`). */
  codex: boolean;
  /** OpenCode (`~/.config/opencode/plugins`). */
  opencode: boolean;
}

/**
 * Approval-notification settings for vibecoding CLIs. The primary detection
 * path is per-tool permission HOOKS (exact — the tool tells us it is waiting),
 * replacing the old terminal-output regex scan. `scanFallback` keeps the scan
 * as an opt-in compatibility mode (off by default).
 */
export interface ApprovalSettings {
  /** Master switch: run the local hook listener and surface approvals. */
  enabled: boolean;
  /** Local HTTP port the hook scripts POST to (default 47890). */
  port: number;
  /** Per-tool enable toggles. */
  tools: ApprovalHookTools;
  /** Legacy terminal-output regex scan (off by default). */
  scanFallback: boolean;
}

/**
 * Account / sync configuration. The server address, username and auth token
 * are local-only (they must NOT be synced); nickname & avatar are managed by
 * the sync server and mirrored here for the Settings page.
 */
export interface AccountSettings {
  /** Sync server base URL, e.g. `http://127.0.0.1:8765`. */
  serverUrl: string;
  /** Logged-in username (empty = logged out). */
  username: string;
  /** Bearer token from the sync server (not persisted in the synced data). */
  token: string;
  /** Display nickname (synced via the server profile). */
  nickname: string;
  /** Avatar as a data: URL (synced via the server profile). */
  avatar: string;
  /** Epoch ms of the last successful sync. */
  lastSyncAt: number;
}

/** Persisted AI configuration (stored under the `ai` key of AppSettings). */
export interface AISettings {  provider: AIProviderKind;
  /** Base URL, e.g. `https://api.openai.com/v1` or `http://localhost:11434`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** Inject the active terminal's host/cwd as a system context message. */
  terminalContext: boolean;
  /** Surface a dismissible "let AI fix it?" hint when the output trips a known error. */
  errorHints: boolean;
  /** When a command error is detected, automatically ask the AI to explain the
   *  cause and stream the diagnosis to the bottom panel (no manual click). */
  autoDiagnose: boolean;
  /** Use the local knowledge base (when a path is configured) to augment prompts. */
  useKnowledgeBase: boolean;
  /** Root directory scanned for the local knowledge base. */
  knowledgeBasePath: string;
  /**
   * Ask the provider to skip its "thinking / reasoning" pass for faster first
   * tokens. Mapped per API family: OpenAI-compatible gets `reasoning_effort:
   * "low"` + DeepSeek's `thinking.disabled`, Ollama gets `think: false`.
   * Providers without a reasoning mode ignore the extra fields.
   */
  disableThinking: boolean;
}

export interface AIChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** True while tokens are still streaming in. */
  streaming?: boolean;
  /** True if the assistant turn ended with an error. */
  error?: boolean;
  /** True when the user manually stopped the generation. */
  cancelled?: boolean;
}

export interface AIChatSession {
  id: string;
  title: string;
  messages: AIChatMessage[];
  createdAt: number;
  /**
   * Session used by machine-driven flows (inline agent runs, auto-diagnose).
   * Transient sessions are excluded from the history list and can be purged in
   * bulk, so agent transcripts and auto-diagnostics never pollute the chat
   * history the user sees.
   */
  transient?: boolean;
}

/** Provider config sent to the Rust backend (mirrors `ProviderConfig` in ai/provider.rs). */
export interface AIProviderConfig {
  kind: AIProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** Ask the provider to skip its thinking/reasoning pass (see AISettings). */
  disableThinking?: boolean;
}

export interface AIChunkPayload {
  id: string;
  delta: string;
}

export interface AIDonePayload {
  id: string;
  error: string | null;
}

/** Fired by the backend when a vibecoding CLI (Claude Code, Codex, …) appears to
 *  be waiting for the user to approve an action. Mirrors `PermRequest` in Rust. */
export interface PermRequest {
  sessionId: string;
  /** e.g. "Claude Code", "Codex", "Coding Agent". */
  tool: string;
  /** ANSI-stripped, truncated prompt text / command. */
  snippet: string;
  /** Unix epoch millis when detected. */
  ts: number;
  /** `"hook"` — the tool's own permission hook fired (primary, exact);
   *  `"scan"` — legacy terminal-output regex scan (opt-in compat). */
  source: "hook" | "scan";
}

// --- J-Link (SEGGER debug probe) ---------------------------------------------

/** Target connection settings for J-Link operations. */
export interface JLinkConfig {
  /** Device name as understood by J-Link, e.g. "STM32F103C8". */
  device: string;
  /** Transport: "SWD" (default) or "JTAG". */
  iface: "SWD" | "JTAG";
  /** Interface speed in kHz; 0 means "auto". */
  speed: number;
}

/** Result of any J-Link operation (one-shot or GDB server control). */
export interface JLinkResponse {
  success: boolean;
  output: string;
}

/** Summary returned after exporting the unified data profile. */
export interface ProfileExportInfo {
  path: string;
  hosts: number;
  quickCommands: number;
  settings: number;
  fonts: number;
  includeSecrets: boolean;
  exportedAt: string;
}

/** Summary returned after importing a data profile. */
export interface ProfileImportInfo {
  hosts: number;
  quickCommands: number;
  settings: number;
  fonts: number;
  mode: string;
}
