import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  Attached,
  BleDeviceInfo,
  BleOpenConfig,
  Host,
  HostMetrics,
  KnownHostEntry,
  LocalEntry,
  PortForwardRule,
  PortForwardStatus,
  QuickCommand,
  RemoteFile,
  RemoteFileMeta,
  SerialOpenConfig,
  SerialPortInfo,
  SessionClosed,
  SshConnectConfig,
  SshConnectResult,
  StreamChunk,
  TransferProgress,
  UsbDevice,
  UsbVerify,
  WslDistro,
  WslLaunchConfig,
  FrpConfig,
  FrpLaunchConfig,
  AIProviderConfig,
  AIChatMessage,
  JLinkConfig,
  JLinkResponse,
  JLinkStatus,
  ProfileExportInfo,
  ProfileImportInfo,
  PermState,
  MqttConnection,
  MqttConnectConfig,
  MqttMessage,
  MqttStatus,
  DashPanel,
  GitStatus,
  GitBranches,
  GitDiff,
  GitCommit,
  GitSnapshot,
  DockerContainer,
  DockerImage,
  DockerRunOptions,
  ProtocolConfig,
  ProtocolSummary,
  FieldValue,
  ParsedFrame,
  ProtocolFrameEvent,
} from "./types";

/**
 * Thin typed layer over Tauri IPC.
 *
 * Backend errors arrive as plain strings (see `AppError`'s Serialize impl), so
 * every call surface here rethrows a real `Error` with that message intact.
 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : JSON.stringify(err));
  }
}

// --- SSH -------------------------------------------------------------------

export const ssh = {
  connect: (config: SshConnectConfig) =>
    call<SshConnectResult>("ssh_connect", { config }),
  write: (sessionId: string, data: string) =>
    call<void>("ssh_write", { sessionId, data }),
  resize: (sessionId: string, cols: number, rows: number) =>
    call<void>("ssh_resize", { sessionId, cols, rows }),
  exec: (sessionId: string, command: string) =>
    call<string>("ssh_exec", { sessionId, command }),
  disconnect: (sessionId: string) => call<void>("ssh_disconnect", { sessionId }),
  sessions: () => call<string[]>("ssh_sessions"),
  attach: (sessionId: string) => call<Attached>("ssh_attach", { sessionId }),

  onData: (sessionId: string, cb: (chunk: StreamChunk) => void): Promise<UnlistenFn> =>
    listen<StreamChunk>(`ssh-data-${sessionId}`, (e) => cb(e.payload)),
  onClosed: (sessionId: string, cb: (info: SessionClosed) => void): Promise<UnlistenFn> =>
    listen<SessionClosed>(`ssh-closed-${sessionId}`, (e) => cb(e.payload)),

  // --- Port forwarding ---
  forwardList: (sessionId: string) =>
    call<PortForwardStatus[]>("ssh_forward_list", { sessionId }),
  forwardStart: (sessionId: string, rule: PortForwardRule) =>
    call<PortForwardStatus>("ssh_forward_start", { sessionId, rule }),
  forwardStop: (id: string) => call<void>("ssh_forward_stop", { id }),
  forwardSave: (rule: PortForwardRule) =>
    call<PortForwardRule>("ssh_forward_save", { rule }),
  forwardDelete: (id: string) => call<void>("ssh_forward_delete", { id }),
  forwardRules: (hostId: string) =>
    call<PortForwardRule[]>("ssh_forward_rules", { hostId }),

  // --- Known hosts ---
  knownHostsList: () => call<KnownHostEntry[]>("ssh_known_hosts_list"),
  knownHostsRemove: (host: string, port: number) =>
    call<void>("ssh_known_hosts_remove", { host, port }),
};

// --- SFTP ------------------------------------------------------------------

export const sftp = {
  list: (sessionId: string, path: string) =>
    call<RemoteFile[]>("sftp_list", { sessionId, path }),
  realpath: (sessionId: string, path: string) =>
    call<string>("sftp_realpath", { sessionId, path }),
  mkdir: (sessionId: string, path: string) =>
    call<void>("sftp_mkdir", { sessionId, path }),
  remove: (sessionId: string, path: string, isDir: boolean) =>
    call<void>("sftp_remove", { sessionId, path, isDir }),
  rename: (sessionId: string, from: string, to: string) =>
    call<void>("sftp_rename", { sessionId, from, to }),
  stat: (sessionId: string, path: string) =>
    call<RemoteFileMeta>("sftp_stat", { sessionId, path }),
  /** Read a remote text file for inline editing (server enforces a size cap). */
  read: (sessionId: string, remotePath: string) =>
    call<string>("sftp_read", { sessionId, remotePath }),
  /** Read a remote file's raw bytes as base64 for in-app preview (images, PDF,
   *  video, audio). Server enforces a size cap and returns an error for files
   *  that are too large to preview inline. */
  readBytes: (sessionId: string, remotePath: string) =>
    call<string>("sftp_read_bytes", { sessionId, remotePath }),
  /** Overwrite a remote file with text content. */
  write: (sessionId: string, remotePath: string, content: string) =>
    call<void>("sftp_write", { sessionId, remotePath, content }),
  /** Change a remote file's mode and/or owner/group (names resolved remotely). */
  setPerms: (
    sessionId: string,
    path: string,
    permissions: number | null,
    owner: string | null,
    group: string | null,
  ) =>
    call<void>("sftp_set_perms", { sessionId, path, permissions, owner, group }),
  download: (
    sessionId: string,
    remotePath: string,
    localPath: string,
    transferId: string,
    offset?: number,
  ) =>
    call<void>("sftp_download", {
      sessionId,
      remotePath,
      localPath,
      transferId,
      offset: offset ?? null,
    }),
  upload: (
    sessionId: string,
    localPath: string,
    remoteDir: string,
    transferId: string,
    offset?: number,
  ) =>
    call<string>("sftp_upload", {
      sessionId,
      localPath,
      remoteDir,
      transferId,
      offset: offset ?? null,
    }),
  /** Copy a file straight from one remote host to another (no local disk). */
  remoteCopy: (
    fromSessionId: string,
    toSessionId: string,
    remotePath: string,
    remoteDir: string,
    transferId: string,
    offset?: number,
  ) =>
    call<string>("sftp_remote_copy", {
      fromSessionId,
      toSessionId,
      remotePath,
      remoteDir,
      transferId,
      offset: offset ?? null,
    }),

  onProgress: (cb: (p: TransferProgress) => void): Promise<UnlistenFn> =>
    listen<TransferProgress>("sftp-progress", (e) => cb(e.payload)),
};

// --- Monitoring ------------------------------------------------------------

export const monitoring = {
  remote: (sessionId: string) => call<HostMetrics>("remote_metrics", { sessionId }),
  local: () => call<HostMetrics>("local_metrics"),
};

// --- Serial ----------------------------------------------------------------

export const serial = {
  listPorts: () => call<SerialPortInfo[]>("serial_list_ports"),
  baudRates: () => call<number[]>("serial_baud_rates"),
  open: (config: SerialOpenConfig) => call<string>("serial_open", { config }),
  write: (sessionId: string, data: string) =>
    call<void>("serial_write", { sessionId, data }),
  signals: (sessionId: string, dtr?: boolean, rts?: boolean) =>
    call<void>("serial_signals", { sessionId, dtr, rts }),
  close: (sessionId: string) => call<void>("serial_close", { sessionId }),
  attach: (sessionId: string) => call<Attached>("serial_attach", { sessionId }),

  onData: (sessionId: string, cb: (chunk: StreamChunk) => void): Promise<UnlistenFn> =>
    listen<StreamChunk>(`serial-data-${sessionId}`, (e) => cb(e.payload)),
  onClosed: (sessionId: string, cb: (info: SessionClosed) => void): Promise<UnlistenFn> =>
    listen<SessionClosed>(`serial-closed-${sessionId}`, (e) => cb(e.payload)),
};

// --- Bluetooth Low Energy --------------------------------------------------
// Structurally identical to `serial` on purpose: both emit StreamChunk /
// SessionClosed, so the workspace can treat them as one transport interface.

export const ble = {
  /** False when there's no adapter, or Bluetooth is switched off. */
  available: () => call<boolean>("ble_available"),
  /**
   * Run a discovery window. `service` filters advertisements the same way the
   * reference project's `filters: [{ services }]` did; omit it to accept all.
   */
  scan: (durationMs?: number, service?: string) =>
    call<BleDeviceInfo[]>("ble_scan", { durationMs, service }),
  open: (config: BleOpenConfig) => call<string>("ble_open", { config }),
  write: (sessionId: string, data: string) => call<void>("ble_write", { sessionId, data }),
  close: (sessionId: string) => call<void>("ble_close", { sessionId }),
  attach: (sessionId: string) => call<Attached>("ble_attach", { sessionId }),

  onData: (sessionId: string, cb: (chunk: StreamChunk) => void): Promise<UnlistenFn> =>
    listen<StreamChunk>(`ble-data-${sessionId}`, (e) => cb(e.payload)),
  onClosed: (sessionId: string, cb: (info: SessionClosed) => void): Promise<UnlistenFn> =>
    listen<SessionClosed>(`ble-closed-${sessionId}`, (e) => cb(e.payload)),
};

// --- Local PTY -------------------------------------------------------------

export const pty = {
  spawn: (cols: number, rows: number, shell?: string, cwd?: string) =>
    call<string>("pty_spawn", { cols, rows, shell, cwd }),
  /** The shell a "Default" local PTY would launch on this machine (per OS). */
  defaultShell: () => call<string>("default_shell", {}),
  write: (sessionId: string, data: string) =>
    call<void>("pty_write", { sessionId, data }),
  resize: (sessionId: string, cols: number, rows: number) =>
    call<void>("pty_resize", { sessionId, cols, rows }),
  close: (sessionId: string) => call<void>("pty_close", { sessionId }),
  attach: (sessionId: string) => call<Attached>("pty_attach", { sessionId }),

  onData: (sessionId: string, cb: (chunk: StreamChunk) => void): Promise<UnlistenFn> =>
    listen<StreamChunk>(`pty-data-${sessionId}`, (e) => cb(e.payload)),
  onClosed: (sessionId: string, cb: (info: SessionClosed) => void): Promise<UnlistenFn> =>
    listen<SessionClosed>(`pty-closed-${sessionId}`, (e) => cb(e.payload)),
};

// --- WSL -------------------------------------------------------------------

/**
 * WSL sessions are plain PTY sessions under the hood — only `spawn` is
 * WSL-specific. Use `pty.write` / `pty.resize` / `pty.close` / `pty.attach`
 * and the `pty-*` events for everything else.
 */
export const wsl = {
  /** Empty array = WSL works but no distro installed. Throws if WSL is absent. */
  listDistros: () => call<WslDistro[]>("wsl_list_distros"),

  spawn: (cfg: WslLaunchConfig, cols: number, rows: number) =>
    call<string>("wsl_spawn", {
      hostId: cfg.hostId || undefined,
      distro: cfg.distro || undefined,
      user: cfg.user || undefined,
      cwd: cfg.cwd || undefined,
      cols,
      rows,
    }),
};

// --- Frp -------------------------------------------------------------------

/**
 * Frp tunnels are plain PTY sessions under the hood — only `spawn` is
 * Frp-specific (it builds an `frpc.toml` and launches `frpc`). Use
 * `pty.write` / `pty.resize` / `pty.close` / `pty.attach` and the `pty-*`
 * events for everything else.
 */
export const frp = {
  spawn: (cfg: FrpLaunchConfig, cols: number, rows: number) =>
    call<string>("frp_spawn", {
      hostId: cfg.hostId || undefined,
      config: cfg.config,
      cols,
      rows,
    }),
};

// --- WSL USB Device Manager (usbipd-win) ----------------------------------
//
// Wraps the backend's `usbip_*` commands. `attach`/`detach`/`verify` run on a
// dedicated blocking pool so they can never stall terminal input.

export const usb = {
  /** Whether `usbipd-win` is installed on the Windows host. */
  isInstalled: () => call<boolean>("usbip_installed"),
  /** Enumerate embedded-dev USB devices currently visible to Windows. */
  list: () => call<UsbDevice[]>("usbip_list"),
  /** Bind (if needed) + attach a device into a WSL distro, then verify. */
  attach: (busid: string, distro: string) =>
    call<UsbVerify>("usbip_attach", { busid, distro }),
  /** Detach a device, returning it to Windows. */
  detach: (busid: string) => call<void>("usbip_detach", { busid }),
  /** Re-verify an attached device inside WSL. */
  verify: (distro: string) => call<UsbVerify>("usbip_verify", { distro }),
  /** Launch the interactive winget installer for usbipd-win. */
  install: () => call<void>("usbip_install"),
};

// --- WSL filesystem (mirrors `sftp`, but on the local `\\wsl$\` share) -------

export const wslFs = {
  list: (distro: string | undefined, path: string) =>
    call<RemoteFile[]>("wsl_list", { distro: distro ?? undefined, path }),
  home: (distro: string | undefined) =>
    call<string>("wsl_home", { distro: distro ?? undefined }),
  mkdir: (distro: string | undefined, path: string) =>
    call<void>("wsl_mkdir", { distro: distro ?? undefined, path }),
  remove: (distro: string | undefined, path: string, isDir: boolean) =>
    call<void>("wsl_remove", { distro: distro ?? undefined, path, isDir }),
  rename: (distro: string | undefined, from: string, to: string) =>
    call<void>("wsl_rename", { distro: distro ?? undefined, from, to }),
  download: (
    distro: string | undefined,
    remotePath: string,
    localPath: string,
    transferId: string,
  ) =>
    call<void>("wsl_download", {
      distro: distro ?? undefined,
      remotePath,
      localPath,
      transferId,
    }),
  upload: (
    distro: string | undefined,
    localPath: string,
    remoteDir: string,
    transferId: string,
  ) =>
    call<string>("wsl_upload", {
      distro: distro ?? undefined,
      localPath,
      remoteDir,
      transferId,
    }),

  onProgress: (cb: (p: TransferProgress) => void): Promise<UnlistenFn> =>
    listen<TransferProgress>("wsl-progress", (e) => cb(e.payload)),
};

// --- MQTT (ported MQTTX-style functionality) -------------------------------

export const mqtt = {
  /** Open a live session. `config.password` may be "__saved__" with a `hostId`
   *  to reveal a stored credential server-side. Returns the session id. */
  connect: (config: MqttConnectConfig) => call<string>("mqtt_connect", { config }),
  disconnect: (id: string) => call<void>("mqtt_disconnect", { id }),
  /** `payload` is base64 (binary-safe). `hostId` persists the publish form. */
  publish: (
    id: string,
    topic: string,
    payload: string,
    qos: number,
    retain: boolean,
    hostId?: string | null,
  ) => call<void>("mqtt_publish", { id, topic, payload, qos, retain, hostId: hostId ?? null }),
  /** `hostId` persists the subscription so it survives tab close / syncs. */
  subscribe: (id: string, topic: string, qos: number, hostId?: string | null) =>
    call<void>("mqtt_subscribe", { id, topic, qos, hostId: hostId ?? null }),
  unsubscribe: (id: string, topic: string, hostId?: string | null) =>
    call<void>("mqtt_unsubscribe", { id, topic, hostId: hostId ?? null }),

  onMessage: (id: string, cb: (m: MqttMessage) => void): Promise<UnlistenFn> =>
    listen<MqttMessage>(`mqtt-message-${id}`, (e) => cb(e.payload)),
  onStatus: (id: string, cb: (s: MqttStatus) => void): Promise<UnlistenFn> =>
    listen<MqttStatus>(`mqtt-status-${id}`, (e) => cb(e.payload)),
};

export const mqttConnections = {
  list: (includeSecrets = false) =>
    call<MqttConnection[]>("mqtt_list_connections", { includeSecrets }),
  save: (conn: MqttConnection) => call<MqttConnection>("mqtt_save_connection", { conn }),
  delete: (id: string) => call<void>("mqtt_delete_connection", { id }),
};

// --- Storage ---------------------------------------------------------------

export const db = {
  listHosts: (includeSecrets = false) =>
    call<Host[]>("db_list_hosts", { includeSecrets }),
  saveHost: (host: Host) => call<Host>("db_save_host", { host }),
  deleteHost: (id: string) => call<void>("db_delete_host", { id }),

  listQuickCommands: () => call<QuickCommand[]>("db_list_quick_commands"),
  saveQuickCommand: (command: QuickCommand) =>
    call<QuickCommand>("db_save_quick_command", { command }),
  deleteQuickCommand: (id: string) => call<void>("db_delete_quick_command", { id }),

  getSettings: () => call<Record<string, unknown>>("db_get_settings"),
  setSetting: (key: string, value: unknown) => call<void>("db_set_setting", { key, value }),
};

// --- Fonts -------------------------------------------------------------------

export const dash = {
  list: () => call<DashPanel[]>("dash_panels_list"),
  save: (panel: DashPanel) => call<DashPanel>("dash_panel_save", { panel }),
  delete: (id: string) => call<void>("dash_panel_delete", { id }),
};

export const fonts = {
  /** All system-installed font families (used to build a searchable checklist). */
  listFonts: () => call<string[]>("list_fonts"),
  /** Persist an imported font. `data` is the raw file as a base64 string. */
  importFont: (family: string, data: string) =>
    call<string>("import_font", { family, data }),
  /** Families of previously imported fonts. */
  listImportedFonts: () => call<string[]>("list_imported_fonts"),
  /** Read an imported font back as base64 (for runtime `FontFace` registration). */
  readFont: (family: string) => call<string>("read_font", { family }),
};

// --- AI ----------------------------------------------------------------------

export interface AIChatRequest {
  provider: AIProviderConfig;
  messages: { role: string; content: string }[];
  context?: string;
  /**
   * Caller-generated request id so the frontend can register its event
   * listeners before invoking (eliminates the lost-`ai-done` race on fast
   * providers). Omit to let the backend generate one.
   */
  id?: string;
}

export const ai = {
  /** Starts a streaming chat completion; returns the request id used to
   *  subscribe to `ai-chunk-{id}` / `ai-done-{id}` events. */
  chat: (req: AIChatRequest) => call<string>("ai_chat", { req }),
  /** Abort an in-flight completion. */
  cancel: (id: string) => call<void>("ai_cancel", { id }),
  /** Drop stale in-flight entries (e.g. after a webview reload). */
  clearInflight: () => call<void>("ai_clear_inflight"),
};

// --- Knowledge base --------------------------------------------------------

export const kb = {
  scan: (root: string) => call<{ path: string; name: string; content: string }[]>("kb_scan", { root }),
  read: (path: string) => call<string>("kb_read", { path }),
};

// --- Local filesystem (dual-pane SFTP tab, right pane) ---------------------

export const localFs = {
  home: () => call<string>("local_home"),
  list: (path: string) => call<LocalEntry[]>("local_list", { path }),
  mkdir: (path: string) => call<void>("local_mkdir", { path }),
  remove: (path: string, isDir: boolean) => call<void>("local_remove", { path, isDir }),
  rename: (from: string, to: string) => call<void>("local_rename", { from, to }),
  reveal: (path: string) => call<void>("reveal_path", { path }),
  open: (path: string) => call<void>("open_path", { path }),
  /** Write text to an arbitrary local path (used by exporters that let the
   *  user pick a target directory + filename via the native save dialog). */
  writeText: (path: string, content: string) =>
    call<void>("local_write_text", { path, content }),
  /** Open a URL in the OS default browser (http/https only). */
  openUrl: (url: string) => call<void>("open_url", { url }),
};

// --- J-Link (SEGGER debug probe) -------------------------------------------

/** Normalize an optional custom J-Link path: blank → undefined (auto-detect). */
function jlinkExe(v?: string): string | undefined {
  return v && v.trim() ? v.trim() : undefined;
}

export const jlink = {
  available: (exePath?: string) =>
    call<boolean>("jlink_available", { exePath: jlinkExe(exePath) }),
  /** List every device supported by the installed J-Link driver. */
  devices: (exePath?: string) =>
    call<string[]>("jlink_devices", { exePath: jlinkExe(exePath) }),
  connect: (config: JLinkConfig, exePath?: string) =>
    call<JLinkResponse>("jlink_connect", { config, exePath: jlinkExe(exePath) }),
  /** Cached "last successful connect" — used to render the workspace header badge. */
  status: () => call<JLinkStatus>("jlink_status"),
  /** Clear the cached connect — wired to the workspace Disconnect button. */
  disconnect: () => call<JLinkStatus>("jlink_disconnect"),
  reset: (config: JLinkConfig, mode: "reset" | "halt" | "go", exePath?: string) =>
    call<JLinkResponse>("jlink_reset", { config, mode, exePath: jlinkExe(exePath) }),
  readMem: (config: JLinkConfig, addr: string, len: number, exePath?: string) =>
    call<JLinkResponse>("jlink_read_mem", { config, addr, len, exePath: jlinkExe(exePath) }),
  writeMem: (config: JLinkConfig, addr: string, data: string, exePath?: string) =>
    call<JLinkResponse>("jlink_write_mem", { config, addr, data, exePath: jlinkExe(exePath) }),
  erase: (config: JLinkConfig, exePath?: string) =>
    call<JLinkResponse>("jlink_erase", { config, exePath: jlinkExe(exePath) }),
  program: (config: JLinkConfig, file: string, addr?: string, exePath?: string) =>
    call<JLinkResponse>("jlink_program", { config, file, addr, exePath: jlinkExe(exePath) }),
  gdbStart: (config: JLinkConfig, port: number, exePath?: string) =>
    call<JLinkResponse>("jlink_gdb_start", { config, port, exePath: jlinkExe(exePath) }),
  gdbStop: () => call<JLinkResponse>("jlink_gdb_stop"),
  gdbRunning: () => call<boolean>("jlink_gdb_running"),
  /** Subscribe to J-Link GDB Server log lines. */
  onGdbLog: (cb: (line: string) => void): Promise<UnlistenFn> =>
    listen<string>("jlink-gdb-log", (e) => cb(e.payload)),
  /** Start RTT: a J-Link Commander + JLinkRTTClient pair streaming channel 0. */
  rttStart: (config: JLinkConfig, exePath?: string) =>
    call<JLinkResponse>("jlink_rtt_start", { config, exePath: jlinkExe(exePath) }),
  rttStop: () => call<JLinkResponse>("jlink_rtt_stop"),
  rttRunning: () => call<boolean>("jlink_rtt_running"),
  /** Send bytes (base64) to the target's RTT channel 0. */
  rttSend: (data: string) => call<JLinkResponse>("jlink_rtt_send", { data }),
  /** Subscribe to raw RTT channel-0 bytes (base64-encoded 4 KB chunks). */
  onRttData: (cb: (b64: string) => void): Promise<UnlistenFn> =>
    listen<string>("jlink-rtt-data", (e) => cb(e.payload)),
  /** Subscribe to RTT host/client diagnostic lines. */
  onRttLog: (cb: (line: string) => void): Promise<UnlistenFn> =>
    listen<string>("jlink-rtt-log", (e) => cb(e.payload)),
  /** Launch a SEGGER J-Link GUI tool (Config / J-Flash / SWO / RTT viewer). */
  launchTool: (tool: "config" | "jflash" | "swo" | "rttviewer", exePath?: string) =>
    call<JLinkResponse>("jlink_launch_tool", { tool, exePath: jlinkExe(exePath) }),
};

// --- Unified data profile (export / import / future sync) -------------------

export const profile = {
  /** Write settings + hosts + quick commands to one versioned JSON file. */
  export: (path: string, includeSecrets: boolean) =>
    call<ProfileExportInfo>("profile_export", { path, includeSecrets }),
  /** Apply a profile file. mode: "merge" (upsert) or "replace" (wipe first). */
  import: (path: string, mode: "merge" | "replace") =>
    call<ProfileImportInfo>("profile_import", { path, mode }),
};

// --- Native notifications ---------------------------------------------------

export const notify = {
  /** Raise a native OS notification attributed to DevOps Station. Used to alert
   *  the user even when the window is backgrounded/minimized. */
  show: (title: string, body: string) => call<void>("notify_show", { title, body }),
  /** Enable or disable native OS notifications for agent/CLI approval prompts. */
  setApprovalNotifications: (enabled: boolean) =>
    call<void>("set_approval_notifications", { enabled }),
};

// --- Approval permission hooks (primary detection path) ----------------------

export interface HookStatus {
  /** Whether our hook is currently installed for the tool. */
  installed: boolean;
  /** Whether the tool's config file exists (tool appears present). */
  toolDetected: boolean;
  /** The config path we manage. */
  configPath: string;
}

/**
 * Local approval endpoint + per-tool permission hooks (Claude Code / Codex /
 * OpenCode). The hooks fire exactly when the tool needs approval and POST to
 * `127.0.0.1:{port}/approval`; no more terminal-output regex scanning.
 */
export const permHook = {
  /** Start the local listener (idempotent for the same port). `tools` is the
   *  set of managed tool ids whose hooks are re-asserted on every launch so an
   *  install survives a restart. */
  start: (port: number, tools?: string[]) =>
    call<void>("perm_hook_start", { port, tools: tools ?? null }),
  /** Stop the local listener. */
  stop: () => call<void>("perm_hook_stop"),
  /** Install the notify hook for a tool (`claude` | `codex` | `opencode`). */
  install: (tool: string, port: number) =>
    call<string>("perm_hook_install", { tool, port }),
  /** Remove our hook from a tool's config. */
  uninstall: (tool: string) => call<string>("perm_hook_uninstall", { tool }),
  /** Query whether our hook is installed / the tool is present. */
  status: (tool: string) => call<HookStatus>("perm_hook_status", { tool }),
  /** Enable/disable the legacy terminal-output scan (compat mode, default off). */
  setScanFallback: (enabled: boolean) =>
    call<void>("set_scan_fallback", { enabled }),
  /** Fetch the current AI-agent activity snapshot (per-project traffic lights). */
  state: () => call<PermState>("perm_state", {}),
  /** Tell the backend a session was acted on (approve/reject/dismiss) so it
   *  stops reminding and clears the traffic-light entry. */
  ack: (sessionId: string) => call<void>("perm_ack", { sessionId }),
  /**
   * Register the OS-level quick-approve shortcut (accelerator string like
   * "Ctrl+Shift+Enter", or null/empty to unregister). Fires "approval-shortcut"
   * to the frontend even when the window has no focus.
   */
  setGlobalShortcut: (accelerator: string | null) =>
    call<void>("set_global_approve_shortcut", { accelerator: accelerator ?? "" }),
};

// --- Git -------------------------------------------------------------------
// `distro` is only set for WSL sessions; it lets the backend translate the
// unix cwd to the `\\wsl$\<distro>` UNC share. Local sessions pass undefined.

export const git = {
  /** Batched status + branch snapshot — one IPC call instead of two (and on
   *  WSL, one `wsl.exe` spawn instead of ~3). Use this for the panel refresh.
   *  `sessionId` routes the call over an SSH session (remote hosts). */
  snapshot: (cwd: string, distro?: string, sessionId?: string) =>
    call<GitSnapshot>("git_snapshot", { cwd, distro: distro ?? null, sshSession: sessionId ?? null }),
  status: (cwd: string, distro?: string, sessionId?: string) =>
    call<GitStatus>("git_status", { cwd, distro: distro ?? null, sshSession: sessionId ?? null }),
  branches: (cwd: string, distro?: string, sessionId?: string) =>
    call<GitBranches>("git_branches", { cwd, distro: distro ?? null, sshSession: sessionId ?? null }),
  stage: (cwd: string, paths: string[], distro?: string, sessionId?: string) =>
    call<string>("git_stage", { cwd, paths, distro: distro ?? null, sshSession: sessionId ?? null }),
  unstage: (cwd: string, paths: string[], distro?: string, sessionId?: string) =>
    call<string>("git_unstage", { cwd, paths, distro: distro ?? null, sshSession: sessionId ?? null }),
  commit: (cwd: string, message: string, amend: boolean, distro?: string, sessionId?: string) =>
    call<string>("git_commit", { cwd, message, amend, distro: distro ?? null, sshSession: sessionId ?? null }),
  checkout: (cwd: string, branch: string, distro?: string, sessionId?: string) =>
    call<string>("git_checkout", { cwd, branch, distro: distro ?? null, sshSession: sessionId ?? null }),
  newBranch: (cwd: string, name: string, distro?: string, sessionId?: string) =>
    call<string>("git_new_branch", { cwd, name, distro: distro ?? null, sshSession: sessionId ?? null }),
  fetch: (cwd: string, distro?: string, sessionId?: string) =>
    call<string>("git_fetch", { cwd, distro: distro ?? null, sshSession: sessionId ?? null }),
  pull: (cwd: string, distro?: string, sessionId?: string) =>
    call<string>("git_pull", { cwd, distro: distro ?? null, sshSession: sessionId ?? null }),
  push: (cwd: string, distro?: string, sessionId?: string) =>
    call<string>("git_push", { cwd, distro: distro ?? null, sshSession: sessionId ?? null }),
  diff: (cwd: string, path: string, staged: boolean, distro?: string, sessionId?: string) =>
    call<GitDiff>("git_diff", { cwd, path, staged, distro: distro ?? null, sshSession: sessionId ?? null }),
  log: (cwd: string, distro?: string, sessionId?: string) =>
    call<GitCommit[]>("git_log", { cwd, distro: distro ?? null, sshSession: sessionId ?? null }),
  commitDiff: (cwd: string, hash: string, distro?: string, sessionId?: string) =>
    call<GitDiff>("git_commit_diff", { cwd, hash, distro: distro ?? null, sshSession: sessionId ?? null }),
  reset: (cwd: string, mode: string, target: string, distro?: string, sessionId?: string) =>
    call<string>("git_reset", { cwd, mode, target, distro: distro ?? null, sshSession: sessionId ?? null }),
  checkoutCommit: (cwd: string, hash: string, distro?: string, sessionId?: string) =>
    call<string>("git_checkout_commit", { cwd, hash, distro: distro ?? null, sshSession: sessionId ?? null }),
};

// --- Docker ----------------------------------------------------------------
// `distro` is only set for WSL sessions; `sessionId` routes the call over an
// SSH session (remote hosts). Local sessions pass both as undefined.

export const docker = {
  /** Whether a Docker daemon is reachable in the target environment. */
  available: (distro?: string, sessionId?: string) =>
    call<boolean>("docker_available", { distro: distro ?? null, sshSession: sessionId ?? null }),
  /** List all containers (running + stopped). */
  ps: (distro?: string, sessionId?: string) =>
    call<DockerContainer[]>("docker_ps", { distro: distro ?? null, sshSession: sessionId ?? null }),
  /** List images. */
  images: (distro?: string, sessionId?: string) =>
    call<DockerImage[]>("docker_images", { distro: distro ?? null, sshSession: sessionId ?? null }),
  /** Start a container. */
  start: (id: string, distro?: string, sessionId?: string) =>
    call<void>("docker_start", { id, distro: distro ?? null, sshSession: sessionId ?? null }),
  /** Stop a container. */
  stop: (id: string, distro?: string, sessionId?: string) =>
    call<void>("docker_stop", { id, distro: distro ?? null, sshSession: sessionId ?? null }),
  /** Restart a container. */
  restart: (id: string, distro?: string, sessionId?: string) =>
    call<void>("docker_restart", { id, distro: distro ?? null, sshSession: sessionId ?? null }),
  /** Remove a container. */
  remove: (id: string, force: boolean, distro?: string, sessionId?: string) =>
    call<void>("docker_remove", { id, force, distro: distro ?? null, sshSession: sessionId ?? null }),
  /** Remove an image. */
  rmi: (id: string, force: boolean, distro?: string, sessionId?: string) =>
    call<void>("docker_rmi", { id, force, distro: distro ?? null, sshSession: sessionId ?? null }),
  /** Pull an image. Returns the pull progress text. */
  pull: (name: string, distro?: string, sessionId?: string) =>
    call<string>("docker_pull", { name, distro: distro ?? null, sshSession: sessionId ?? null }),
  /** Fetch the last `tail` lines of a container's logs. */
  logs: (id: string, tail: number, distro?: string, sessionId?: string) =>
    call<string>("docker_logs", { id, tail, distro: distro ?? null, sshSession: sessionId ?? null }),
  /** Create and start a container from `opts`. Returns the new container id. */
  run: (opts: DockerRunOptions, distro?: string, sessionId?: string) =>
    call<string>("docker_run", { opts, distro: distro ?? null, sshSession: sessionId ?? null }),
  /** Run a docker compose action against the compose file at `path`. */
  compose: (path: string, action: string, distro?: string, sessionId?: string) =>
    call<string>("docker_compose", { path, action, distro: distro ?? null, sshSession: sessionId ?? null }),
};

// --- Protocol Designer ------------------------------------------------------
//
// Backend parses/encodes bytes in a worker thread and never touches the serial
// transport — the UI feeds it raw bytes (base64) and gets parsed frames back.
// `head` / `tail` are hex *strings* on the frontend (loose input) but stored as
// byte vectors on the backend, so the API keeps them as strings and the backend
// parses them via its own hex helper.

export const protocol = {
  /** List all saved protocol summaries. */
  list: () => call<ProtocolSummary[]>("protocol_list"),
  /** Create or update a protocol (empty `id` → backend assigns a UUID).
   *  Returns the persisted config including the assigned `id`. */
  save: (config: ProtocolConfig) => call<ProtocolConfig>("protocol_save", { config }),
  /** Load a full protocol config by id. */
  load: (id: string) => call<ProtocolConfig>("protocol_load", { id }),
  /** Delete a protocol by id. */
  delete: (id: string) => call<void>("protocol_delete", { id }),
  /** Duplicate a protocol under a new name; returns the new config. */
  duplicate: (id: string, newName: string) => call<ProtocolConfig>("protocol_duplicate", { id, newName }),
  /** Parse a base64 byte buffer into all contained frames. */
  parse: (id: string, raw: string, config?: ProtocolConfig | null) =>
    call<ParsedFrame[]>("protocol_parse", { id, raw, config: config ?? null }),
  /** Encode structured field values into a wire frame; returns base64. */
  encode: (id: string, fields: FieldValue[], config?: ProtocolConfig | null) =>
    call<string>("protocol_encode", { id, fields, config: config ?? null }),
  /** Open a loopback channel (virtual channel) for offline testing. */
  loopbackOpen: (id: string, config: ProtocolConfig) =>
    call<void>("protocol_loopback_open", { id, config }),
  /** Feed base64 bytes into an open loopback channel. */
  loopbackSend: (id: string, data: string) =>
    call<void>("protocol_loopback_send", { id, data }),
  /** Push a fresh config into an already-open loopback channel. */
  loopbackReload: (id: string, config: ProtocolConfig) =>
    call<void>("protocol_loopback_reload", { id, config }),
  /** Close a loopback channel. */
  loopbackClose: (id: string) => call<void>("protocol_loopback_close", { id }),

  /** Subscribe to parsed frames from a loopback channel. */
  onFrame: (id: string, cb: (evt: ProtocolFrameEvent) => void): Promise<UnlistenFn> =>
    listen<ProtocolFrameEvent>(`protocol-frame-${id}`, (e) => cb(e.payload)),
};

/**
 * Terminate the application process. Called by the frontend after the
 * `confirm-exit` dialog accepts; the backend side of the close-request hook
 * has already called `api.prevent_close()`, so we have to drive the exit
 * ourselves from JS-land.
 */
export const appExit = () => invoke("app_exit");
