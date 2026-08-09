import { create } from "zustand";

import { db } from "@/lib/api";
import type { Host, QuickCommand } from "@/lib/types";

interface HostsState {
  hosts: Host[];
  quickCommands: QuickCommand[];
  loading: boolean;
  error?: string;

  load: () => Promise<void>;
  saveHost: (host: Host) => Promise<Host>;
  deleteHost: (id: string) => Promise<void>;
  saveQuickCommand: (cmd: QuickCommand) => Promise<void>;
  deleteQuickCommand: (id: string) => Promise<void>;
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

  load: async () => {
    set({ loading: true, error: undefined });
    try {
      const [hosts, quickCommands] = await Promise.all([
        db.listHosts(),
        db.listQuickCommands(),
      ]);
      set({ hosts, quickCommands, loading: false });
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
}));
