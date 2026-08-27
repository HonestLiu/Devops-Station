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
  /** Remote login shell (e.g. "/bin/bash", "fish"), probed at connect. */
  shell?: string;
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

/** A user-authored terminal snippet: a named, reusable multi-line command. */
export interface Snippet {
  id: string;
  name: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** Sort order for the snippet list. */
export type SnippetSortKey = "name" | "created" | "updated";

export interface StreamChunk {
  sessionId: string;
  /** base64 */
  data: string;
}

export interface SessionClosed {
  sessionId: string;
  reason: string;
  exitCode?: number | null;
  /** PTY-only: true when the console (ConPTY) I/O pipe broke while the shell
   *  process is still alive (e.g. OpenCode's rapid double Ctrl+C tore down the
   *  pseudoconsole). The UI should restart the shell instead of showing the
   *  fatal "connection closed" state. */
  restart?: boolean;
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

/** Which J-Link module a `jlink` tab hosts (mirrors `mqttModule`). */
export type JLinkModule = "flash" | "rtt" | "gdb";

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
  /** Per-host (or per-kind, when hostless) monotonically increasing open
   *  index — 1st/2nd/3rd… tab opened for that host. Used by the tab bar to
   *  badge "which number open". Stays fixed even after a middle tab closes. */
  hostSeq?: number;
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
  /**
   * J-Link module tabs only: which module this tab hosts. A tab with
   * `jlinkModule` set renders the matching workspace (Flash / RTT / GDB);
   * `jlink` (the probe config) seeds its connection settings.
   */
  jlinkModule?: JLinkModule;
  /** SSH only — cached credentials/config so Reconnect and Split can reconnect. */
  sshConfig?: SshConnectConfig;
  /** SSH only — the remote login shell probed at connect (e.g. "/bin/bash",
   *  "fish"). Lets the OSC 7 emitter match the real shell instead of assuming
   *  bash; assuming bash is what left the Git panel stuck on a stale (clean)
   *  home dir for fish/sh/dash remotes. */
  remoteShell?: string;
  /** MQTT only — the saved connection profile backing this live session. */
  mqtt?: MqttConnection;
  /**
   * MQTT module tabs only: which module this tab hosts. A tab with `mqtt`
   * set is a live connection (`MqttWorkspace`); a tab with `mqttModule` but
   * no `mqtt` is the standalone HMI dashboard module (`DashPage`).
   */
  mqttModule?: "dash";
  /**
   * Serial module tabs only: which module this tab hosts. A tab with
   * `serialModule` set renders the matching module (`basic` launcher or
   * `designer` placeholder) instead of a live serial/ BLE session
   * (`SerialWorkspace`). Mirrors `jlinkModule` / `mqttModule`.
   */
  serialModule?: "basic" | "designer";
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
 * Object-storage sync configuration (S3-compatible / MinIO / Tencent COS /
 * Cloudflare R2). These are LOCAL credentials — they are stored on this device
 * only and are intentionally NOT synced, so one device can never hijack
 * another's sync target. `deviceId` is injected by the backend, so it is not
 * part of this interface.
 */
export interface SyncConfig {
  /** S3-compatible endpoint, e.g. `https://s3.us-east-1.amazonaws.com` or
   *  `http://127.0.0.1:9000` (MinIO). */
  endpoint: string;
  /** Signing region (`us-east-1` works for most non-AWS providers). */
  region: string;
  /** Bucket name. */
  bucket: string;
  /** Access Key ID. */
  accessKeyId: string;
  /** Secret Access Key. */
  secretAccessKey: string;
  /** Optional object prefix (folder) inside the bucket; empty = bucket root. */
  prefix: string;
  /** Path-style URLs (MinIO / R2 / COS usually need this). Virtual-host for AWS. */
  pathStyle: boolean;
  /** Embed saved plaintext passwords in the pushed profile so synced devices
   *  work seamlessly without re-entering credentials. The profile is the user's
   *  own object-storage object. */
  includeSecrets: boolean;
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

/**
 * Identities of every configurable keyboard shortcut (registry in
 * `src/lib/shortcuts.ts`). All are app-window shortcuts except `quickApprove`,
 * which is also registered as an OS-level global hotkey.
 */
export type ShortcutId =
  | "quickApprove"
  | "toggleAi"
  | "togglePalette"
  | "splitPaneCol"
  | "splitPaneRow"
  | "closePane"
  | "focusPaneLeft"
  | "focusPaneRight"
  | "focusPaneUp"
  | "focusPaneDown";

/** One shortcut's user configuration. `spec` is a "modifier+Code" string, e.g.
 *  "ctrl+shift+Enter" (see `parseShortcut` in lib/shortcut.ts). */
export interface ShortcutBinding {
  spec: string;
  enabled: boolean;
}

/** Persisted per-shortcut bindings (stored under the `shortcuts` key). */
export type ShortcutSettings = Record<ShortcutId, ShortcutBinding>;

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
  /** Project directory the agent runs in, when known. */
  cwd?: string;
}

/** Status of a single AI-agent session (mirrors `AgentStatus` in Rust). */
export type AgentStatus = "idle" | "working" | "waitingapproval" | "resolved";

/** One agent session tracked by the backend (per-project traffic light). */
export interface AgentSession {
  sessionId: string;
  tool: string;
  status: AgentStatus;
  snippet: string;
  cwd?: string | null;
  ts: number;
  escalated: boolean;
}

/** A project (or fallback grouping) aggregating its agent sessions. */
export interface ProjectLight {
  projectId: string;
  projectLabel: string;
  status: AgentStatus;
  sessions: AgentSession[];
  lastEventAt: number;
}

/** Snapshot of all AI-agent activity; payload of `perm-state-changed`. */
export interface PermState {
  lights: ProjectLight[];
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

/**
 * Cached "last successful connect" snapshot, mirrored from the Rust backend.
 * The probe itself is one-shot per script — there's no long-lived session —
 * so this is purely a UI snapshot that the workspace header shows in the
 * connection badge. Empty `device` means "not connected".
 */
export interface JLinkStatus {
  device: string;
  iface: string;
  speed: number;
  serial?: string;
  /** Unix seconds of the last successful connect. 0 when not connected. */
  connectedAt: number;
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

// --- HMI dashboards ("上位机") -------------------------------------------------

/** Persisted dashboard panel record (backend row). */
export interface DashPanel {
  id: string;
  name: string;
  connectionId: string;
  connectionName: string;
  /** JSON-serialised DashPanelJson. */
  json: string;
  sortOrder: number;
  updatedAt: number;
}

/** Widget instance placed on a panel grid. */
export interface DashWidget {
  id: string;
  /** Registry widget type, e.g. "toggle". */
  type: string;
  /** Grid position (x/y in columns, w/h in columns x rows). */
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  /** Subscribe (input) topics — raw MQTT payloads are fed to parseFn. */
  topics: string[];
  /** Publish (output) topic used by publishFn. */
  pubTopic: string;
  /** User-editable JS function body: (payload, topic) => { ... return vars }. */
  parseFn: string;
  /** User-editable JS function body: (value) => payload-string/JSON. */
  publishFn: string;
  /** Per-type extras (knob min/max, chart series, thresholds, …). */
  config: Record<string, unknown>;
}

export interface DashBackground {
  kind: "color" | "image";
  color?: string;
  image?: string;
}

export interface DashPanelJson {
  cols: number;
  widgets: DashWidget[];
  background: DashBackground;
}

/** Latest raw payload + parsed values for a widget (runtime only, not persisted). */
export interface DashWidgetRuntime {
  raw: string;
  rawAt: number;
  values: Record<string, unknown>;
  parseError?: string;
}

// --- Git sidebar -----------------------------------------------------------

/** One file in the working tree (from `git status --porcelain`). */
export interface GitFileEntry {
  /** Path as reported by git (may be `old -> new` for renames). */
  path: string;
  /** First porcelain column — index / staged status. */
  x: string;
  /** Second porcelain column — worktree / unstaged status. */
  y: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

/** Parsed `git status` output. */
export interface GitStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitFileEntry[];
}

/** Parsed `git branch` / `git branch -r` output. */
export interface GitBranches {
  current: string;
  branches: string[];
  remotes: string[];
}

/** Raw unified-diff text for a single file. */
export interface GitDiff {
  /** Unified diff body (empty when no textual diff, e.g. binary). */
  text: string;
  /** True when git reports the file as binary (no line diff available). */
  binary: boolean;
}

/** One commit from `git log`. */
export interface GitCommit {
  /** Full 40-char SHA. */
  hash: string;
  /** Abbreviated SHA (7 chars). */
  shortHash: string;
  author: string;
  /** Author date as YYYY-MM-DD. */
  date: string;
  /** First line of the message. */
  subject: string;
  /** Remaining message body (may be empty). */
  body: string;
}

/** Combined status + branch snapshot returned by `git.snapshot`. */
export interface GitSnapshot {
  status: GitStatus;
  branches: GitBranches;
}

// --- Docker sidebar --------------------------------------------------------

/** One container, as reported by `docker ps --format '{{json .}}'`. */
export interface DockerContainer {
  id: string;
  names: string;
  image: string;
  status: string;
  /** Coarse lifecycle state: running | exited | paused | created | ... */
  state: string;
  ports: string;
  created: string;
  command: string;
  size: string;
}

/** One image, as reported by `docker images --format '{{json .}}'`. */
export interface DockerImage {
  id: string;
  repo: string;
  tag: string;
  size: string;
  created: string;
}

/** Options for `docker run`, sent from the run-container form. */
export interface DockerRunOptions {
  image: string;
  name?: string;
  ports: string[];
  envs: string[];
  cmd?: string;
  detach: boolean;
  rm: boolean;
}

/** Valid `docker compose` actions exposed in the UI. */
export type DockerComposeAction = "up" | "down" | "ps" | "restart";

// --- Protocol Designer ------------------------------------------------------

/** Byte-endianness for multi-byte integer / float fields. */
export type Endian = "little" | "big";

/** Checksum / frame-integrity algorithm applied to a byte range of the frame. */
export type ChecksumAlgo = "none" | "sum" | "xor" | "crc8" | "crc16modbus" | "crc32";

/** Typed interpretation of a field's bytes when decoding. */
export type FieldDataType =
  | "uint8"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "float32"
  | "float64"
  | "hexstring"
  | "asciistring"
  | "bitfield";

/** Optional length-field descriptor used for frame delimiting. */
export interface LengthField {
  /** Byte offset of the length field, relative to frame start (0 = first byte). */
  offset: number;
  /** Width of the length field in bytes (1 / 2 / 4). */
  length: number;
  /** Whether the length value includes the length field's own bytes. */
  includeSelf: boolean;
}

/** A single field definition inside a protocol. */
export interface FieldDef {
  /** Machine name (unique within the protocol), e.g. `temperature`. */
  name: string;
  /** Human-friendly display name, e.g. `温度值`. */
  displayName: string;
  /** Byte offset relative to frame start (0-based). */
  offset: number;
  /** Field width in bytes. */
  length: number;
  dataType: FieldDataType;
  /** Multiplier converting the raw integer/float to a physical value. */
  scale?: number | null;
  /** Physical unit, e.g. `°C`. */
  unit?: string | null;
  /** Raw-value → readable-string map, e.g. `{ "1": "启动" }`. */
  enumMap?: Record<string, string> | null;
  /** Simple show/parse condition, e.g. `command == 1`. */
  condition?: string | null;
}

/** Checksum configuration: algorithm + byte range (relative to frame start). */
export interface ChecksumConfig {
  algo: ChecksumAlgo;
  /** First byte index of the checksummed range (inclusive). Defaults to 0. */
  start?: number | null;
  /** Last byte index of the checksummed range (exclusive). Defaults to frame end. */
  end?: number | null;
}

/** A complete protocol definition (the unit of CRUD + storage). */
export interface ProtocolConfig {
  /** Stable id; empty on first save → backend assigns a UUID. */
  id: string;
  name: string;
  description?: string | null;
  /**
   * Markdown documentation for the protocol (user manual / notes). Rendered in
   * the designer's bottom "doc" section, with a toggle between edit & preview.
   */
  doc?: string | null;
  /**
   * Fixed frame head. On the editing side this is a loose hex string
   * (e.g. "AA BB"); when sent to the backend it is converted to a byte array
   * (`number[]`), which serde reads as `Vec<u8>`. Optional.
   */
  head?: string | number[] | null;
  /** Fixed frame tail — same representation as `head`. Optional. */
  tail?: string | number[] | null;
  lengthField?: LengthField | null;
  fields: FieldDef[];
  checksum?: ChecksumConfig | null;
  endian?: Endian | null;
  /** Inter-frame idle timeout (ms) — used by the UI for frame splitting. */
  timeoutMs: number;
  /**
   * Auto-answer rules (P2): when an incoming frame's `whenField == whenValue`,
   * the loopback channel encodes `reply` (field overrides) and emits it as a
   * simulated device reply. Optional.
   */
  autoAnswer?: AutoAnswerRule[] | null;
  createdAt: number;
  updatedAt: number;
}

/** One auto-answer rule (P2). */
export interface AutoAnswerRule {
  /** Whether the rule is active. Defaults to true. */
  enabled?: boolean | null;
  /** Human-readable note shown in the UI. */
  note?: string | null;
  /** Field name to test against the parsed frame. */
  whenField: string;
  /** Value the field must equal to trigger the reply. */
  whenValue: number;
  /** Field overrides used to build the reply frame (field name → value). */
  reply: FieldValue[];
}

/** Lightweight row for the protocol list (avoids shipping full configs). */
export interface ProtocolSummary {
  id: string;
  name: string;
  description?: string | null;
  updatedAt: number;
}

/** One field's decoded result inside a parsed frame. */
export interface ParsedField {
  name: string;
  displayName: string;
  /** Raw bytes as a hex string (e.g. `A1 02`). */
  rawValue: string;
  /** Decoded value (number / string / object). */
  value: unknown;
  /** Display string after scale + enum mapping, e.g. `25.6 °C`. */
  displayValue: string;
  unit?: string | null;
  /** Byte offset within the frame (for Hex-view highlighting). */
  byteOffset: number;
  /** Byte length within the frame. */
  byteLength: number;
}

/** Direction of a parsed frame, so the UI can tell what the user sent apart
 *  from what the device (or the simulated loopback auto-answer) sent back. */
export type FrameDir = "tx" | "rx" | "reply";

/** A single parsed frame (may be partial / invalid if parsing failed). */
export interface ParsedFrame {
  /** Full frame bytes as a base64 string (compact over the wire; the UI
   *  decodes to render the Hex view + highlight). */
  raw: string;
  valid: boolean;
  checksumValid: boolean;
  fields: ParsedField[];
  errorMsg?: string | null;
  /** True when this frame was produced by an auto-answer rule. */
  isReply?: boolean | null;
  /** Who produced this frame: `tx` (user), `rx` (device), `reply` (auto-answer). */
  dir?: FrameDir | null;
}

/** A field value supplied to the encoder for structured sending. */
export interface FieldValue {
  name: string;
  value: unknown;
}

/** Payload emitted on `protocol-frame-{id}` (loopback) events. */
export interface ProtocolFrameEvent {
  channelId: string;
  frame: ParsedFrame;
  /** Echo of the raw bytes that were fed in (base64), for the Hex view. */
  raw: string;
  /** True when this frame was produced by an auto-answer rule. */
  isReply?: boolean | null;
  /** Direction of the frame (mirrors `ParsedFrame.dir`). */
  dir?: FrameDir | null;
}

