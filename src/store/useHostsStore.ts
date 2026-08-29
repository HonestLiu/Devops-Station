import { create } from "zustand";

import { db, wsl } from "@/lib/api";
import { normalizeDistro } from "@/components/DistroIcon";
import type { Host, HostSortKey, QuickCommand } from "@/lib/types";

/** Sort keys offered by the Hosts page dropdown, in menu order. */
export const HOST_SORT_KEYS: HostSortKey[] = [
  "recent",
  "nameAsc",
  "nameDesc",
  "newest",
  "oldest",
];

const SORT_KEY = "hosts-sort-v1";

function loadSort(): HostSortKey {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw && (HOST_SORT_KEYS as string[]).includes(raw)) return raw as HostSortKey;
  } catch {
    /* ignore corrupt storage */
  }
  return "recent";
}

interface HostsState {
  hosts: Host[];
  quickCommands: QuickCommand[];
  loading: boolean;
  error?: string;
  /** Preferred list ordering for the Hosts page (persisted). */
  sort: HostSortKey;

  load: () => Promise<void>;
  saveHost: (host: Host) => Promise<Host>;
  deleteHost: (id: string) => Promise<void>;
  saveQuickCommand: (cmd: QuickCommand) => Promise<void>;
  deleteQuickCommand: (id: string) => Promise<void>;
  setSort: (k: HostSortKey) => void;
  /**
   * Record "connected just now" so the most-recently-used sort can float this
   * host to the top without waiting for a reload. The backend already persists
   * it (`touch_host`); this only keeps the in-memory copy in sync.
   */
  touchHost: (id: string) => void;
}

export function emptyHost(kind: Host["kind"]): Host {
  return {
    id: "",
    name: "",
    kind,
    hostname: "",
    port: 22,
    username: "",
    password: "",
    privateKeyPath: "",
    passphrase: "",
    savePassword: true,
    serialPort: "",
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
    color: null,
    tags: [],
    lastUsed: null,
    createdAt: null,
  };
}

export const useHostsStore = create<HostsState>((set, get) => ({
  hosts: [],
  quickCommands: [],
  loading: false,
  sort: loadSort(),

  load: async () => {
    set({ loading: true, error: undefined });
    try {
      const [hosts, quickCommands] = await Promise.all([
        db.listHosts(),
        db.listQuickCommands(),
      ]);
      set({ hosts, quickCommands, loading: false });
      // WSL hosts created without an explicit distro ("default") have no
      // `wslDistro` to fall back on, so their list icon depends entirely on a
      // detected `distro`. Backfill it from the system's default WSL distro so
      // the icon is stable across restarts even if connect-time detection was
      // skipped or lost.
      const needDistro = hosts.filter(
        (h) => h.kind === "wsl" && !h.wslDistro && !h.distro,
      );
      if (needDistro.length) {
        wsl
          .listDistros()
          .then((list) => {
            const def = list.find((d) => d.isDefault) ?? list[0];
            const detected = def ? normalizeDistro(def.name) : null;
            if (!detected) return;
            for (const h of needDistro) {
              void get().saveHost({ ...h, distro: detected });
            }
          })
          .catch(() => undefined);
      }
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  saveHost: async (host) => {
    const saved = await db.saveHost(host);
    const existing = get().hosts.findIndex((h) => h.id === saved.id);
    const hosts = [...get().hosts];
    if (existing >= 0) hosts[existing] = saved;
    else hosts.unshift(saved);
    set({ hosts });
    return saved;
  },

  deleteHost: async (id) => {
    await db.deleteHost(id);
    set({ hosts: get().hosts.filter((h) => h.id !== id) });
  },

  saveQuickCommand: async (cmd) => {
    const saved = await db.saveQuickCommand(cmd);
    const list = [...get().quickCommands];
    const idx = list.findIndex((c) => c.id === saved.id);
    if (idx >= 0) list[idx] = saved;
    else list.push(saved);
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    set({ quickCommands: list });
  },

  deleteQuickCommand: async (id) => {
    await db.deleteQuickCommand(id);
    set({ quickCommands: get().quickCommands.filter((c) => c.id !== id) });
  },

  setSort: (k) => {
    set({ sort: k });
    try {
      localStorage.setItem(SORT_KEY, k);
    } catch {
      /* ignore quota errors */
    }
  },

  touchHost: (id) => {
    if (!id) return;
    const hosts = get().hosts;
    if (!hosts.some((h) => h.id === id)) return;
    // Unix *seconds* — matches `chrono::Utc::now().timestamp()` in the backend.
    const now = Math.floor(Date.now() / 1000);
    set({ hosts: hosts.map((h) => (h.id === id ? { ...h, lastUsed: now } : h)) });
  },
}));
