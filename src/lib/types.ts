export type HostKind = "ssh" | "serial" | "local" | "wsl" | "frp";

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
}

export interface SshConnectResult {
  sessionId: string;
  serverKeyFingerprint: string;
  homeDir: string;
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

export interface QuickCommand {
  id: string;
  name: string;
  value: string;
  scope: "ssh" | "serial" | "both";
  isHex: boolean;
  sortOrder: number;
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

export type ThemeId = "tokyo-night" | "dark" | "light" | "nord" | "dracula";

export type TabKind = "ssh" | "serial" | "local" | "wsl" | "frp";

export type TabStatus = "connecting" | "connected" | "closed" | "error";

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  subtitle: string;
  status: TabStatus;
  /** Backend session id; absent while connecting. */
  sessionId?: string;
  hostId?: string;
  error?: string;
  /** SSH only */
  cwd?: string;
  fingerprint?: string;
  /** Serial only */
  serial?: SerialOpenConfig;
  /** WSL only — kept so Reconnect can respawn with the same distro/user. */
  wsl?: WslLaunchConfig;
  /** Frp only — kept so Reconnect can respawn the same tunnel. */
  frp?: FrpLaunchConfig;
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

/** Persisted AI configuration (stored under the `ai` key of AppSettings). */
export interface AISettings {
  provider: AIProviderKind;
  /** Base URL, e.g. `https://api.openai.com/v1` or `http://localhost:11434`. */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** Inject the active terminal's host/cwd as a system context message. */
  terminalContext: boolean;
  /** Use the local knowledge base (when a path is configured) to augment prompts. */
  useKnowledgeBase: boolean;
  /** Root directory scanned for the local knowledge base. */
  knowledgeBasePath: string;
}

export interface AIChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** True while tokens are still streaming in. */
  streaming?: boolean;
  /** True if the assistant turn ended with an error. */
  error?: boolean;
}

export interface AIChatSession {
  id: string;
  title: string;
  messages: AIChatMessage[];
  createdAt: number;
}

/** Provider config sent to the Rust backend (mirrors `ProviderConfig` in ai/provider.rs). */
export interface AIProviderConfig {
  kind: AIProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
}

export interface AIChunkPayload {
  id: string;
  delta: string;
}

export interface AIDonePayload {
  id: string;
  error: string | null;
}
