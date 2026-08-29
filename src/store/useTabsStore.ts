import { create } from "zustand";

import { ble, frp, mqtt, pty, serial, ssh, wsl } from "@/lib/api";
import { tFrom } from "@/i18n";
import { connectSshWithHostKeyPrompt } from "@/lib/sshConnect";
import { useAppStore } from "@/store/useAppStore";
import { useHostsStore } from "@/store/useHostsStore";
import { useSessionStore } from "@/store/useSessionStore";
import { normalizeDistro } from "@/components/DistroIcon";
import type {
  BleOpenConfig,
  DistroId,
  FrpConfig,
  FrpLaunchConfig,
  Host,
  JLinkModule,
  MqttConnection,
  SerialOpenConfig,
  SshConnectConfig,
  Tab,
  TermPane,
  WslLaunchConfig,
} from "@/lib/types";

let counter = 0;
const nextId = () => `tab-${++counter}`;
let paneCounter = 0;
const nextPaneId = () => `pane-${++paneCounter}`;
let groupCounter = 0;
const nextGroupId = () => `grp-${++groupCounter}`;

/** Drop `group` from tabs that are their group's only remaining member. */
function pruneSingleGroups(tabs: Tab[]): Tab[] {
  const counts = new Map<string, number>();
  for (const t of tabs) if (t.group) counts.set(t.group, (counts.get(t.group) ?? 0) + 1);
  return tabs.map((t) =>
    t.group && (counts.get(t.group) ?? 0) <= 1 ? { ...t, group: undefined } : t,
  );
}

/** Non-React translate helper — the tabs store runs outside React. */
function lang(
  key: Parameters<typeof tFrom>[1],
  params?: Record<string, string | number>,
): string {
  return tFrom(useAppStore.getState().settings.language, key, params);
}

/**
 * After a successful SSH connection, detect the remote distribution and persist
 * it on the host so the list icon updates. Best-effort and non-blocking: callers
 * should invoke it without awaiting and swallow rejections.
 */
async function detectAndSaveDistro(sessionId: string, hostId?: string) {
  if (!hostId) return;
  try {
    const raw = await ssh.exec(
      sessionId,
      "cat /etc/os-release 2>/dev/null || uname -s 2>/dev/null",
    );
    const distro = normalizeDistro(raw);
    if (!distro) return;
    const host = useHostsStore.getState().hosts.find((h) => h.id === hostId);
    if (host && host.distro !== distro) {
      await useHostsStore.getState().saveHost({ ...host, distro });
    }
  } catch {
    // Detection is best-effort; ignore failures (e.g. exec unsupported).
  }
}

/**
 * Resolve a WSL host's distribution so its list icon can match the actual OS.
 * WSL is a local PTY with no exec channel, so unlike SSH we can't run
 * `cat /etc/os-release` inside the session. Instead we use the launch config's
 * distro, or — when that's empty (the WSL default) — the Windows-side
 * `wsl -l` list. The result is persisted on the host as `distro`.
 * Best-effort and non-blocking.
 */
async function detectAndSaveWslDistro(distroName: string | undefined, hostId?: string) {
  if (!hostId) return;
  let detected: DistroId | null = null;
  try {
    if (distroName) {
      detected = normalizeDistro(distroName);
    } else {
      const list = await wsl.listDistros();
      const def = list.find((d) => d.isDefault) ?? list[0];
      if (def) detected = normalizeDistro(def.name);
    }
  } catch {
    return;
  }
  if (!detected) return;
  const host = useHostsStore.getState().hosts.find((h) => h.id === hostId);
  if (host && host.distro !== detected) {
    await useHostsStore.getState().saveHost({ ...host, distro: detected });
  }
}

interface TabsState {
  tabs: Tab[];
  activeId?: string;

  setActive: (id: string) => void;
  /** Return to the page view, hiding any open connection tab. */
  focusPage: () => void;
  closeTab: (id: string) => Promise<void>;
  closeAll: () => Promise<void>;
  patch: (id: string, patch: Partial<Tab>) => void;
  /** Update a single pane inside a tab. */
  patchPane: (tabId: string, paneId: string, patch: Partial<TermPane>) => void;
  /**
   * Append a freshly-created tab and make it active. Stamps `hostSeq` — the
   * per-host (or per-kind, when hostless) monotonically increasing open index —
   * onto the tab so the tab bar can badge it with "which number open" (1st, 2nd,
   * 3rd …) for that host. Closing a middle tab does NOT renumber the survivors.
   */
  addTab: (tab: Tab) => void;

  openSsh: (config: SshConnectConfig, title?: string) => Promise<string>;
  openSerial: (config: SerialOpenConfig, title?: string) => Promise<string>;
  /** BLE transparent-transmission session — same workspace as serial. */
  openBle: (config: BleOpenConfig, title?: string) => Promise<string>;
  openLocal: (cwd?: string) => Promise<string>;
  openWsl: (config: WslLaunchConfig, title?: string) => Promise<string>;
  openFrp: (config: FrpLaunchConfig, title?: string) => Promise<string>;
  /** Open a dedicated SFTP tab backed by an SSH session to a saved host. */
  openSftp: (host: Host, title?: string) => Promise<string>;
  /** Open a live MQTT session tab backed by a saved connection profile. */
  openMqtt: (conn: MqttConnection, title?: string) => Promise<string>;
  /** Open (or focus) the singleton HMI dashboard module tab. */
  openMqttDash: () => string;
  /** Open (or focus) the singleton J-Link module tab (Flash / RTT / GDB). */
  openJlinkModule: (module: JLinkModule, title?: string) => string;
  /** Open (or focus) the singleton Serial module tab (basic launcher /
   *  protocol designer). Mirrors `openJlinkModule` for the serial family. */
  openSerialModule: (module: "basic" | "designer", title?: string) => string;
  openFromHost: (host: Host) => Promise<string>;

  /** SSH: open an extra terminal for the same host (max 4 panes per tab). */
  splitPane: (tabId: string, axis: "col" | "row") => Promise<void>;
  /** Close one split pane (the last pane closes the tab). */
  closePane: (tabId: string, paneId: string) => Promise<void>;
  /** Focus a pane; keeps tab.sessionId in sync for AI/cwd consumers. */
  focusPane: (tabId: string, paneId: string) => void;

  /** Jump to whichever tab/pane owns `sessionId` (used by the notif bell). */
  focusBySession: (sessionId: string) => void;

  /**
   * Merge `sourceId` into `targetId`'s split group: both tabs (and any existing
   * group members) render side-by-side in one view. No session is touched —
   * this is purely a layout grouping. Max 4 members per group.
   */
  groupTabs: (sourceId: string, targetId: string) => void;
  /**
   * Detach `id` from its split group back into a standalone tab. The session
   * keeps running — this is the "close this split pane" action.
   */
  ungroupTab: (id: string) => void;

  /** Re-open a fresh tab of the same kind using the cached connect config. */
  duplicateTab: (id: string) => Promise<void>;

  reconnect: (id: string) => Promise<void>;
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: undefined,

  setActive: (id) => set({ activeId: id }),

  focusPage: () => set({ activeId: undefined }),

  patch: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  patchPane: (tabId, paneId, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId && t.panes
          ? { ...t, panes: t.panes.map((p) => (p.id === paneId ? { ...p, ...patch } : p)) }
          : t,
      ),
    })),

  addTab: (tab) => {
    // Opening a tab means "just connected" — keep the host's in-memory
    // `lastUsed` fresh so the Hosts list can re-sort immediately. The backend
    // persists the same timestamp; this only mirrors it client-side.
    if (tab.hostId) useHostsStore.getState().touchHost(tab.hostId);
    set((s) => {
      // Per-host open index: tabs that share a hostId (or, when hostless, the
      // same kind) form one sequence. The next index is 1 + the highest seq
      // already used by that group, so it never renumbers when a middle tab
      // closes — it only ever grows for new openings.
      const key = tab.hostId ?? tab.kind;
      let maxSeq = 0;
      for (const t of s.tabs) {
        if ((t.hostId ?? t.kind) === key) maxSeq = Math.max(maxSeq, t.hostSeq ?? 0);
      }
      return {
        tabs: [...s.tabs, { ...tab, hostSeq: maxSeq + 1 }],
        activeId: tab.id,
      };
    });
  },

  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    const teardown =
      tab?.kind === "ssh" || tab?.kind === "sftp"
        ? ssh.disconnect
        : tab?.kind === "serial"
          ? serial.close
          : tab?.kind === "ble"
            ? ble.close
            : tab?.kind === "mqtt"
              ? mqtt.disconnect
              : pty.close;
    // Tear down the focused session plus every split-pane session.
    const sessions = [
      tab?.sessionId,
      ...(tab?.panes?.map((p) => p.sessionId) ?? []),
    ].filter((s): s is string => !!s);
    for (const sid of new Set(sessions)) {
      // Fire-and-forget: a dead session shouldn't block closing the tab.
      teardown(sid).catch(() => undefined);
    }
    set((s) => {
      const tabs = pruneSingleGroups(s.tabs.filter((t) => t.id !== id));
      let activeId = s.activeId;
      if (activeId === id) {
        const idx = s.tabs.findIndex((t) => t.id === id);
        activeId = tabs[Math.min(idx, tabs.length - 1)]?.id;
      }
      return { tabs, activeId };
    });
  },

  closeAll: async () => {
    const { tabs, closeTab } = get();
    await Promise.all(tabs.map((t) => closeTab(t.id)));
  },

  openSsh: async (config, title) => {
    const id = nextId();
    const label = title || `${config.username}@${config.hostname}`;
    get().addTab({
      id,
      kind: "ssh",
      title: label,
      subtitle: `${config.hostname}:${config.port}`,
      status: "connecting",
      hostId: config.hostId,
      // Cache the connect config so Reconnect / Split can re-open sessions.
      sshConfig: config,
    });

    try {
      const result = await connectSshWithHostKeyPrompt(config);
      get().patch(id, {
        status: "connected",
        sessionId: result.sessionId,
      cwd: result.homeDir,
      remoteShell: result.shell,
      fingerprint: result.serverKeyFingerprint,
      });
      detectAndSaveDistro(result.sessionId, config.hostId).catch(() => {});
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openSftp: async (host, title) => {
    const config: SshConnectConfig = {
      hostId: host.id,
      hostname: host.hostname ?? "",
      port: host.port ?? 22,
      username: host.username ?? "",
      // Sentinel — the backend swaps it for the decrypted secret.
      password: host.password ?? undefined,
      privateKeyPath: host.privateKeyPath ?? undefined,
      passphrase: host.passphrase ?? undefined,
      cols: 120,
      rows: 32,
      term: "xterm-256color",
    };

    const id = nextId();
    get().addTab({
      id,
      kind: "sftp",
      title: title || `${config.username}@${config.hostname}`,
      subtitle: `${config.hostname}:${config.port} · SFTP`,
      status: "connecting",
      hostId: host.id,
      // Stash the config so Reconnect can re-resolve saved credentials.
      sftpConfig: config,
    });

    try {
      const result = await connectSshWithHostKeyPrompt(config);
      get().patch(id, {
        status: "connected",
        sessionId: result.sessionId,
        cwd: result.homeDir,
        remoteShell: result.shell,
        fingerprint: result.serverKeyFingerprint,
      });
      detectAndSaveDistro(result.sessionId, host.id).catch(() => {});
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openJlinkModule: (module, title) => {
    // A module that is already open is focused, not duplicated.
    const existing = get().tabs.find(
      (t) => t.kind === "jlink" && t.jlinkModule === module,
    );
    if (existing) {
      set({ activeId: existing.id });
      return existing.id;
    }
    const id = nextId();
    const label =
      title ||
      lang(
        module === "rtt" ? "jlink.rtt" : module === "gdb" ? "jlink.gdb" : "jlink.flash",
      );
    get().addTab({
      id,
      kind: "jlink",
      title: label,
      subtitle: lang("tabs.jlink"),
      status: "connected",
      jlinkModule: module,
    });
    return id;
  },

  /**
   * Open (or focus) the singleton Serial module tab — `basic` for the serial /
   * BLE launcher, `designer` for the protocol designer placeholder. Mirrors
   * `openJlinkModule`: an already-open module is focused rather than duplicated.
   */
  openSerialModule: (module, title) => {
    const existing = get().tabs.find(
      (t) => t.kind === "serial" && t.serialModule === module,
    );
    if (existing) {
      set({ activeId: existing.id });
      return existing.id;
    }
    const id = nextId();
    const label =
      title ||
      lang(module === "designer" ? "serial.moduleDesigner" : "serial.moduleBasic");
    get().addTab({
      id,
      kind: "serial",
      title: label,
      subtitle: lang("tabs.serial"),
      status: "connected",
      serialModule: module,
    });
    return id;
  },

  /**
   * Open (or focus) the singleton HMI dashboard module tab. The MQTT client
   * list stays an in-page module (a launcher); only live connections and the
   * dashboard module live in the tab bar.
   */
  openMqttDash: () => {
    const existing = get().tabs.find((t) => t.kind === "mqtt" && t.mqttModule === "dash");
    if (existing) {
      set({ activeId: existing.id });
      return existing.id;
    }
    const id = nextId();
    get().addTab({
      id,
      kind: "mqtt",
      title: lang("dash.title"),
      subtitle: "",
      status: "connected",
      mqttModule: "dash",
      mqtt: undefined,
    });
    return id;
  },

  openMqtt: async (conn, title) => {
    // A connection that is already open is focused, not duplicated.
    if (conn.id) {
      const existing = get().tabs.find((t) => t.kind === "mqtt" && t.mqtt?.id === conn.id);
      if (existing) {
        set({ activeId: existing.id });
        return existing.id;
      }
    }
    const id = nextId();
    get().addTab({
      id,
      kind: "mqtt",
      title: title || conn.name,
      subtitle: `${conn.protocol}://${conn.host}:${conn.port}`,
      status: "connecting",
      mqtt: conn,
    });

    try {
      const sessionId = await mqtt.connect({
        name: conn.name,
        protocol: conn.protocol,
        host: conn.host,
        port: conn.port,
        clientId: conn.clientId,
        username: conn.username ?? undefined,
        password: conn.savePassword ? "__saved__" : conn.password ?? undefined,
        hostId: conn.id,
        clean: conn.clean,
        keepAlive: conn.keepAlive,
        connectTimeout: conn.connectTimeout,
        reconnect: conn.reconnect,
        path: conn.path,
        insecureSkipVerify: conn.insecureSkipVerify,
      });
      get().patch(id, { status: "connecting", sessionId });
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openSerial: async (config, title) => {
    const id = nextId();
    get().addTab({
      id,
      kind: "serial",
      title: title || config.port,
      subtitle: `${config.baudRate} baud`,
      status: "connecting",
      hostId: config.hostId,
      serial: config,
    });

    try {
      const sessionId = await serial.open(config);
      get().patch(id, { status: "connected", sessionId });
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openBle: async (config, title) => {
    const id = nextId();
    const label = title || config.deviceName || config.deviceId;
    get().addTab({
      id,
      kind: "ble",
      title: label,
      subtitle: lang("tabs.ble"),
      status: "connecting",
      hostId: config.hostId,
      ble: config,
    });

    try {
      const sessionId = await ble.open(config);
      get().patch(id, { status: "connected", sessionId });
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openLocal: async (cwd?: string) => {
    const id = nextId();
    const shellPref = useAppStore.getState().settings.localShell;
    // "default" means "the OS login shell" — resolve it on the backend (which
    // knows the platform) rather than guessing on the JS side, so the shell we
    // spawn and the OSC 7 emitter we inject are always in sync.
    const shell =
      shellPref && shellPref !== "default"
        ? shellPref
        : await pty.defaultShell().catch(() => undefined);
    get().addTab({
      id,
      kind: "local",
      title: lang("ws.localShell"),
      subtitle: lang("tabs.local"),
      status: "connecting",
      cwd,
      shell,
    });

    try {
      const sessionId = await pty.spawn(120, 32, shell, cwd);
      get().patch(id, { status: "connected", sessionId, cwd });
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openWsl: async (config, title) => {
    const id = nextId();
    get().addTab({
      id,
      kind: "wsl",
      title: title || (config.distro ? lang("hosts.wslDistro", { distro: config.distro }) : "WSL"),
      subtitle: config.distro || lang("tabs.defaultDistro"),
      status: "connecting",
      hostId: config.hostId,
      // Stash the launch config so Reconnect can respawn identically.
      wsl: config,
    });

    try {
      // WSL sessions are plain PTY sessions — wsl.spawn returns a pty session id.
      const sessionId = await wsl.spawn(config, 120, 32);
      get().patch(id, { status: "connected", sessionId });
      detectAndSaveWslDistro(config.distro, config.hostId).catch(() => {});
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openFrp: async (config, title) => {
    const id = nextId();
    get().addTab({
      id,
      kind: "frp",
      title: title || lang("tabs.frpTunnel"),
      subtitle: config.config.server?.serverAddr || "frpc",
      status: "connecting",
      hostId: config.hostId,
      // Stash the launch config so Reconnect can respawn identically.
      frp: config,
    });

    try {
      // Frp tunnels are plain PTY sessions — frp.spawn returns a pty session id.
      const sessionId = await frp.spawn(config, 120, 32);
      get().patch(id, { status: "connected", sessionId });
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openFromHost: async (host) => {
    if (host.kind === "wsl") {
      return get().openWsl(
        {
          hostId: host.id,
          distro: host.wslDistro || undefined,
          user: host.wslUser || undefined,
          cwd: host.wslCwd || undefined,
        },
        host.name,
      );
    }
    if (host.kind === "frp") {
      let cfg: FrpConfig | undefined;
      try {
        cfg = host.frpConfig ? (JSON.parse(host.frpConfig) as FrpConfig) : undefined;
      } catch {
        cfg = undefined;
      }
      if (!cfg) {
        return get().openFrp(
          { config: { server: { serverAddr: "", serverPort: 7000 }, proxies: [] } },
          host.name,
        );
      }
      return get().openFrp({ hostId: host.id, config: cfg }, host.name);
    }
    if (host.kind === "serial") {
      return get().openSerial(
        {
          hostId: host.id,
          port: host.serialPort ?? "",
          baudRate: host.baudRate ?? 115200,
          dataBits: host.dataBits ?? 8,
          stopBits: host.stopBits ?? 1,
          parity: (host.parity as SerialOpenConfig["parity"]) ?? "none",
          flowControl: (host.flowControl as SerialOpenConfig["flowControl"]) ?? "none",
        },
        host.name,
      );
    }
    return get().openSsh(
      {
        hostId: host.id,
        hostname: host.hostname ?? "",
        port: host.port ?? 22,
        username: host.username ?? "",
        // Sentinel — the backend swaps it for the decrypted secret.
        password: host.password ?? undefined,
        privateKeyPath: host.privateKeyPath ?? undefined,
        passphrase: host.passphrase ?? undefined,
        cols: 120,
        rows: 32,
        term: "xterm-256color",
      },
      host.name,
    );
  },

  splitPane: async (tabId, axis) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    // Split works for the terminal kinds (serial/ble/sftp/jlink excluded).
    if (
      !tab ||
      tab.kind === "serial" ||
      tab.kind === "ble" ||
      tab.kind === "sftp" ||
      tab.kind === "jlink"
    )
      return;
    if (tab.kind === "ssh" && !tab.sshConfig) return;
    if (tab.kind === "wsl" && !tab.wsl) return;
    if (tab.kind === "frp" && !tab.frp) return;

    const panes: TermPane[] = tab.panes ?? [
      { id: nextPaneId(), sessionId: tab.sessionId, status: tab.status },
    ];
    if (panes.length >= 4) return; // max 4 screens

    const pId = nextPaneId();
    const nextPanes = [...panes, { id: pId, status: "connecting" as TermPane["status"] }];
    get().patch(tabId, {
      panes: nextPanes,
      splitAxis: axis,
      focusedPaneId: pId,
      sessionId: undefined,
    });

    try {
      let sessionId: string;
      let homeDir: string | undefined;
      let fingerprint: string | undefined;
      let remoteShell: string | undefined;
      if (tab.kind === "ssh" && tab.sshConfig) {
        const r = await ssh.connect(tab.sshConfig);
        sessionId = r.sessionId;
        homeDir = r.homeDir;
        fingerprint = r.serverKeyFingerprint;
        remoteShell = r.shell;
      } else if (tab.kind === "wsl" && tab.wsl) {
        sessionId = await wsl.spawn(tab.wsl, 120, 32);
        detectAndSaveWslDistro(tab.wsl.distro, tab.hostId).catch(() => {});
      } else if (tab.kind === "frp" && tab.frp) {
        sessionId = await frp.spawn(tab.frp, 120, 32);
      } else {
        sessionId = await pty.spawn(120, 32);
      }
      get().patchPane(tabId, pId, { status: "connected", sessionId });
      // Focus the new pane so typing goes there immediately.
      get().patch(tabId, { sessionId, cwd: homeDir, fingerprint, remoteShell });
      if (tab.kind === "ssh" && tab.hostId) {
        detectAndSaveDistro(sessionId, tab.hostId).catch(() => {});
      }
    } catch (err) {
      get().patchPane(tabId, pId, { status: "error", error: (err as Error).message });
    }
  },

  closePane: async (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const panes = tab.panes ?? [];
    if (panes.length === 0) return;
    const pane = panes.find((p) => p.id === paneId);
    if (pane?.sessionId) {
      const teardown =
        tab.kind === "ssh" || tab.kind === "sftp"
          ? ssh.disconnect
          : tab.kind === "serial"
            ? serial.close
            : tab.kind === "ble"
              ? ble.close
              : pty.close;
      teardown(pane.sessionId).catch(() => undefined);
    }

    const rest = panes.filter((p) => p.id !== paneId);
    if (rest.length === 0) {
      // Closing the last pane closes the whole tab.
      return void get().closeTab(tabId);
    }
    const focusId = tab.focusedPaneId === paneId ? rest[rest.length - 1].id : tab.focusedPaneId;
    const focus = rest.find((p) => p.id === focusId) ?? rest[0];
    get().patch(tabId, {
      panes: rest,
      focusedPaneId: focus.id,
      sessionId: focus.sessionId,
      splitAxis: rest.length === 2 ? tab.splitAxis : undefined,
    });
  },

  focusPane: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    const pane = tab?.panes?.find((p) => p.id === paneId);
    if (!pane) return;
    get().patch(tabId, { focusedPaneId: paneId, sessionId: pane.sessionId });
  },

  focusBySession: (sessionId) => {
    const { tabs, setActive, focusPane } = get();
    for (const t of tabs) {
      const pane = t.panes?.find((p) => p.sessionId === sessionId);
      if (t.sessionId === sessionId || pane) {
        setActive(t.id);
        if (pane) focusPane(t.id, pane.id);
        return;
      }
    }
  },

  groupTabs: (sourceId, targetId) => {
    if (sourceId === targetId) return;
    const { tabs } = get();
    const source = tabs.find((t) => t.id === sourceId);
    const target = tabs.find((t) => t.id === targetId);
    if (!source || !target) return;

    // Join the target's group (or start a new one together).
    const group = target.group ?? nextGroupId();
    const members = tabs.filter((t) => t.group === group).length;
    if (members >= 4) return; // max 4 screens per group

    // Move source right after target so layout order follows drop position.
    const without = tabs.filter((t) => t.id !== sourceId);
    const idx = without.findIndex((t) => t.id === targetId);
    const reordered = [
      ...without.slice(0, idx + 1),
      { ...source, group },
      ...without.slice(idx + 1),
    ];
    set({
      tabs: pruneSingleGroups(
        reordered.map((t) => (t.id === targetId && !t.group ? { ...t, group } : t)),
      ),
      activeId: sourceId,
    });
  },

  ungroupTab: (id) => {
    set((s) => ({
      tabs: pruneSingleGroups(s.tabs.map((t) => (t.id === id ? { ...t, group: undefined } : t))),
    }));
  },

  duplicateTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    switch (tab.kind) {
      case "ssh":
        if (tab.sshConfig) return void get().openSsh(tab.sshConfig, tab.title);
        break;
      case "serial":
        if (tab.serial) return void get().openSerial(tab.serial, tab.title);
        break;
      case "ble":
        if (tab.ble) return void get().openBle(tab.ble, tab.title);
        break;
      case "local":
        return void get().openLocal(tab.cwd);
      case "wsl":
        if (tab.wsl) return void get().openWsl(tab.wsl, tab.title);
        break;
      case "frp":
        if (tab.frp) return void get().openFrp(tab.frp, tab.title);
        break;
      case "sftp": {
        const host = useHostsStore.getState().hosts.find((h) => h.id === tab.hostId);
        if (host) return void get().openSftp(host, tab.title);
        if (tab.sftpConfig) return void get().openSsh(tab.sftpConfig, tab.title);
        break;
      }
      case "jlink":
        return void get().openJlinkModule(tab.jlinkModule ?? "flash", tab.title);
      case "mqtt":
        if (tab.mqtt) return void get().openMqtt(tab.mqtt, tab.title);
        break;
    }
  },

  reconnect: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    // Keep the previous sessionId: the Terminal component hot-swaps to the new
    // session when it lands (screen + scrollback survive), instead of unmounting
    // and wiping the terminal on every reconnect.
    get().patch(id, { status: "connecting", error: undefined });

    try {
      const syncPane = (sessionId: string) => {
        const paneId = tab.focusedPaneId ?? tab.panes?.[0]?.id;
        if (paneId && tab.panes) get().patchPane(id, paneId, { status: "connected", sessionId });
        return sessionId;
      };
      if (tab.kind === "serial" && tab.serial) {
        const sessionId = await serial.open(tab.serial);
        get().patch(id, { status: "connected", sessionId });
      } else if (tab.kind === "ble" && tab.ble) {
        // The backend re-scans when its peripheral cache is cold, so this also
        // works after the device has drifted out of range and come back.
        const sessionId = await ble.open(tab.ble);
        get().patch(id, { status: "connected", sessionId });
      } else if (tab.kind === "local") {
        // Reuse the previously resolved shell so a user-picked shell (e.g. fish,
        // zsh) survives a reconnect instead of falling back to the OS default.
        // Also restart where the user was: the OLD session's live cwd (OSC 7
        // keeps cwdBySession current as they `cd`, unlike the tab's stale
        // initial cwd) — so an auto-restart after a broken terminal session
        // lands back in the same directory instead of the shell's default.
        const liveCwd = tab.sessionId
          ? useSessionStore.getState().cwdBySession[tab.sessionId]
          : undefined;
        get().patch(id, {
          status: "connected",
          sessionId: syncPane(await pty.spawn(120, 32, tab.shell, liveCwd ?? tab.cwd)),
        });
      } else if (tab.kind === "wsl" && tab.wsl) {
        get().patch(id, { status: "connected", sessionId: syncPane(await wsl.spawn(tab.wsl, 120, 32)) });
        detectAndSaveWslDistro(tab.wsl.distro, tab.hostId).catch(() => {});
      } else if (tab.kind === "frp" && tab.frp) {
        get().patch(id, { status: "connected", sessionId: syncPane(await frp.spawn(tab.frp, 120, 32)) });
      } else if (tab.kind === "sftp" && tab.sftpConfig) {
        const result = await connectSshWithHostKeyPrompt(tab.sftpConfig);
        get().patch(id, {
          status: "connected",
          sessionId: result.sessionId,
          cwd: result.homeDir,
          fingerprint: result.serverKeyFingerprint,
        });
      } else if (tab.kind === "jlink") {
        // J-Link tabs are always "connected" (the GDB server / probe state
        // lives in the backend, not this tab) — nothing to re-establish.
        get().patch(id, { status: "connected" });
      } else if (tab.kind === "mqtt" && tab.mqtt) {
        const c = tab.mqtt;
        get().patch(id, { status: "connecting", error: undefined, sessionId: undefined });
        try {
          const sessionId = await mqtt.connect({
            name: c.name,
            protocol: c.protocol,
            host: c.host,
            port: c.port,
            clientId: c.clientId,
            username: c.username ?? undefined,
            password: c.savePassword ? "__saved__" : c.password ?? undefined,
            hostId: c.id,
            clean: c.clean,
            keepAlive: c.keepAlive,
            connectTimeout: c.connectTimeout,
            reconnect: c.reconnect,
            path: c.path,
            insecureSkipVerify: c.insecureSkipVerify,
          });
          get().patch(id, { status: "connected", sessionId });
        } catch (err) {
          get().patch(id, { status: "error", error: (err as Error).message });
        }
      } else if (tab.kind === "ssh" && tab.sshConfig) {
        // Reconnect the focused pane (or the whole tab when not split).
        const result = await connectSshWithHostKeyPrompt(tab.sshConfig);
        const paneId = tab.focusedPaneId ?? tab.panes?.[0]?.id;
        if (paneId && tab.panes) get().patchPane(id, paneId, { status: "connected", sessionId: result.sessionId });
        get().patch(id, {
          status: "connected",
          sessionId: result.sessionId,
          cwd: result.homeDir,
          remoteShell: result.shell,
          fingerprint: result.serverKeyFingerprint,
        });
        detectAndSaveDistro(result.sessionId, tab.hostId).catch(() => {});
      } else {
        // SSH reconnect needs the original credentials, which only the Hosts
        // page holds — surface a clear message instead of failing silently.
        get().patch(id, {
          status: "error",
          error: "Reconnect from the Hosts page so credentials can be resolved.",
        });
      }
    } catch (err) {
      // Clear the session id so the workspace overlay surfaces the failure —
      // otherwise the frozen old terminal would keep rendering with no feedback.
      get().patch(id, { status: "error", error: (err as Error).message, sessionId: undefined });
    }
  },
}));
