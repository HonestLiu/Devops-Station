import { create } from "zustand";

import { frp, pty, serial, ssh, wsl } from "@/lib/api";
import type { FrpConfig, FrpLaunchConfig, Host, SerialOpenConfig, SshConnectConfig, Tab, WslLaunchConfig } from "@/lib/types";

let counter = 0;
const nextId = () => `tab-${++counter}`;

interface TabsState {
  tabs: Tab[];
  activeId?: string;

  setActive: (id: string) => void;
  /** Return to the page view, hiding any open connection tab. */
  focusPage: () => void;
  closeTab: (id: string) => Promise<void>;
  closeAll: () => Promise<void>;
  patch: (id: string, patch: Partial<Tab>) => void;

  openSsh: (config: SshConnectConfig, title?: string) => Promise<string>;
  openSerial: (config: SerialOpenConfig, title?: string) => Promise<string>;
  openLocal: () => Promise<string>;
  openWsl: (config: WslLaunchConfig, title?: string) => Promise<string>;
  openFrp: (config: FrpLaunchConfig, title?: string) => Promise<string>;
  openFromHost: (host: Host) => Promise<string>;

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

  closeTab: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (tab?.sessionId) {
      // Fire-and-forget: a dead session shouldn't block closing the tab.
      const teardown =
        tab.kind === "ssh"
          ? ssh.disconnect
          : tab.kind === "serial"
            ? serial.close
            : pty.close;
      teardown(tab.sessionId).catch(() => undefined);
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

  openLocal: async () => {
    const id = nextId();
    set((s) => ({
      tabs: [
        ...s.tabs,
        {
          id,
          kind: "local",
          title: "Local Shell",
          subtitle: "local",
          status: "connecting",
        },
      ],
      activeId: id,
    }));

    try {
      const sessionId = await pty.spawn(120, 32);
      get().patch(id, { status: "connected", sessionId });
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

  reconnect: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    get().patch(id, { status: "connecting", error: undefined, sessionId: undefined });

    try {
      if (tab.kind === "serial" && tab.serial) {
        const sessionId = await serial.open(tab.serial);
        get().patch(id, { status: "connected", sessionId });
      } else if (tab.kind === "local") {
        const sessionId = await pty.spawn(120, 32);
        get().patch(id, { status: "connected", sessionId });
      } else if (tab.kind === "wsl" && tab.wsl) {
        const sessionId = await wsl.spawn(tab.wsl, 120, 32);
        get().patch(id, { status: "connected", sessionId });
      } else if (tab.kind === "frp" && tab.frp) {
        const sessionId = await frp.spawn(tab.frp, 120, 32);
        get().patch(id, { status: "connected", sessionId });
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
