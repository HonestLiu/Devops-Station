import { create } from "zustand";

import { ble, frp, pty, serial, ssh, wsl } from "@/lib/api";
import { useAppStore } from "@/store/useAppStore";
import { useHostsStore } from "@/store/useHostsStore";
import type {
  BleOpenConfig,
  FrpConfig,
  FrpLaunchConfig,
  Host,
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

  openSsh: (config: SshConnectConfig, title?: string) => Promise<string>;
  openSerial: (config: SerialOpenConfig, title?: string) => Promise<string>;
  /** BLE transparent-transmission session — same workspace as serial. */
  openBle: (config: BleOpenConfig, title?: string) => Promise<string>;
  openLocal: (cwd?: string) => Promise<string>;
  openWsl: (config: WslLaunchConfig, title?: string) => Promise<string>;
  openFrp: (config: FrpLaunchConfig, title?: string) => Promise<string>;
  /** Open a dedicated SFTP tab backed by an SSH session to a saved host. */
  openSftp: (host: Host, title?: string) => Promise<string>;
  openFromHost: (host: Host) => Promise<string>;

  /** SSH: open an extra terminal for the same host (max 4 panes per tab). */
  splitPane: (tabId: string, axis: "col" | "row") => Promise<void>;
  /** Close one split pane (the last pane closes the tab). */
  closePane: (tabId: string, paneId: string) => Promise<void>;
  /** Focus a pane; keeps tab.sessionId in sync for AI/cwd consumers. */
  focusPane: (tabId: string, paneId: string) => void;

  /** Jump to whichever tab/pane owns `sessionId` (used by the notif bell). */
  focusBySession: (sessionId: string) => void;

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

  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    const teardown =
      tab?.kind === "ssh" || tab?.kind === "sftp"
        ? ssh.disconnect
        : tab?.kind === "serial"
          ? serial.close
          : tab?.kind === "ble"
            ? ble.close
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
      const tabs = s.tabs.filter((t) => t.id !== id);
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
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: "ssh",
          title: label,
          subtitle: `${config.hostname}:${config.port}`,
          status: "connecting",
          hostId: config.hostId,
          // Cache the connect config so Reconnect / Split can re-open sessions.
          sshConfig: config,
        },
      ],
      activeId: id,
    }));

    try {
      const result = await ssh.connect(config);
      get().patch(id, {
        status: "connected",
        sessionId: result.sessionId,
        cwd: result.homeDir,
        fingerprint: result.serverKeyFingerprint,
      });
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
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: "sftp",
          title: title || `${config.username}@${config.hostname}`,
          subtitle: `${config.hostname}:${config.port} · SFTP`,
          status: "connecting",
          hostId: host.id,
          // Stash the config so Reconnect can re-resolve saved credentials.
          sftpConfig: config,
        },
      ],
      activeId: id,
    }));

    try {
      const result = await ssh.connect(config);
      get().patch(id, {
        status: "connected",
        sessionId: result.sessionId,
        cwd: result.homeDir,
        fingerprint: result.serverKeyFingerprint,
      });
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openSerial: async (config, title) => {
    const id = nextId();
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: "serial",
          title: title || config.port,
          subtitle: `${config.baudRate} baud`,
          status: "connecting",
          hostId: config.hostId,
          serial: config,
        },
      ],
      activeId: id,
    }));

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
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: "ble",
          title: label,
          subtitle: "BLE",
          status: "connecting",
          hostId: config.hostId,
          ble: config,
        },
      ],
      activeId: id,
    }));

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
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: "local",
          title: "Local Shell",
          subtitle: "local",
          status: "connecting",
          cwd,
          shell,
        },
      ],
      activeId: id,
    }));

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
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: "wsl",
          title: title || (config.distro ? `WSL · ${config.distro}` : "WSL"),
          subtitle: config.distro || "default distro",
          status: "connecting",
          hostId: config.hostId,
          // Stash the launch config so Reconnect can respawn identically.
          wsl: config,
        },
      ],
      activeId: id,
    }));

    try {
      // WSL sessions are plain PTY sessions — wsl.spawn returns a pty session id.
      const sessionId = await wsl.spawn(config, 120, 32);
      get().patch(id, { status: "connected", sessionId });
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
    return id;
  },

  openFrp: async (config, title) => {
    const id = nextId();
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: "frp",
          title: title || "Frp Tunnel",
          subtitle: config.config.server?.serverAddr || "frpc",
          status: "connecting",
          hostId: config.hostId,
          // Stash the launch config so Reconnect can respawn identically.
          frp: config,
        },
      ],
      activeId: id,
    }));

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
    // Split works for the terminal kinds (serial/ble/sftp excluded).
    if (!tab || tab.kind === "serial" || tab.kind === "ble" || tab.kind === "sftp") return;
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
      if (tab.kind === "ssh" && tab.sshConfig) {
        const r = await ssh.connect(tab.sshConfig);
        sessionId = r.sessionId;
        homeDir = r.homeDir;
        fingerprint = r.serverKeyFingerprint;
      } else if (tab.kind === "wsl" && tab.wsl) {
        sessionId = await wsl.spawn(tab.wsl, 120, 32);
      } else if (tab.kind === "frp" && tab.frp) {
        sessionId = await frp.spawn(tab.frp, 120, 32);
      } else {
        sessionId = await pty.spawn(120, 32);
      }
      get().patchPane(tabId, pId, { status: "connected", sessionId });
      // Focus the new pane so typing goes there immediately.
      get().patch(tabId, { sessionId, cwd: homeDir, fingerprint });
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
    }
  },

  reconnect: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    get().patch(id, { status: "connecting", error: undefined, sessionId: undefined });

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
        get().patch(id, {
          status: "connected",
          sessionId: syncPane(await pty.spawn(120, 32, tab.shell)),
        });
      } else if (tab.kind === "wsl" && tab.wsl) {
        get().patch(id, { status: "connected", sessionId: syncPane(await wsl.spawn(tab.wsl, 120, 32)) });
      } else if (tab.kind === "frp" && tab.frp) {
        get().patch(id, { status: "connected", sessionId: syncPane(await frp.spawn(tab.frp, 120, 32)) });
      } else if (tab.kind === "sftp" && tab.sftpConfig) {
        const result = await ssh.connect(tab.sftpConfig);
        get().patch(id, {
          status: "connected",
          sessionId: result.sessionId,
          cwd: result.homeDir,
          fingerprint: result.serverKeyFingerprint,
        });
      } else if (tab.kind === "ssh" && tab.sshConfig) {
        // Reconnect the focused pane (or the whole tab when not split).
        const result = await ssh.connect(tab.sshConfig);
        const paneId = tab.focusedPaneId ?? tab.panes?.[0]?.id;
        if (paneId && tab.panes) get().patchPane(id, paneId, { status: "connected", sessionId: result.sessionId });
        get().patch(id, {
          status: "connected",
          sessionId: result.sessionId,
          cwd: result.homeDir,
          fingerprint: result.serverKeyFingerprint,
        });
      } else {
        // SSH reconnect needs the original credentials, which only the Hosts
        // page holds — surface a clear message instead of failing silently.
        get().patch(id, {
          status: "error",
          error: "Reconnect from the Hosts page so credentials can be resolved.",
        });
      }
    } catch (err) {
      get().patch(id, { status: "error", error: (err as Error).message });
    }
  },
}));
