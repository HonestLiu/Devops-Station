import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  Attached,
  Host,
  HostMetrics,
  LocalEntry,
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

// --- Local PTY -------------------------------------------------------------

export const pty = {
  spawn: (cols: number, rows: number, shell?: string, cwd?: string) =>
    call<string>("pty_spawn", { cols, rows, shell, cwd }),
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
    call<string>("frp_spawn", { config: cfg.config, cols, rows }),
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

// --- Storage ---------------------------------------------------------------

export const db = {
  listHosts: () => call<Host[]>("db_list_hosts"),
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
}

export const ai = {
  /** Starts a (simulated-streaming) chat completion; returns a request id used to
   *  subscribe to `ai-chunk-{id}` / `ai-done-{id}` events. */
  chat: (req: AIChatRequest) => call<string>("ai_chat", { req }),
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
};
