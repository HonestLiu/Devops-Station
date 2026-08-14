import { create } from "zustand";

import { isWaitingForInput } from "@/ai/errorScan";

export interface PermItem {
  id: string;
  sessionId: string;
  tool: string;
  snippet: string;
  /** Detection timestamp (epoch ms). */
  ts: number;
}

interface PermState {
  items: PermItem[];
  unseen: number;
  /** Add a detected request; de-dupes repeats from the same session. */
  push: (p: Omit<PermItem, "id">) => void;
  dismiss: (id: string) => void;
  markSeen: () => void;
  clear: () => void;
}

/** Requests older than this are auto-dropped — a stale prompt has long since resolved. */
const EXPIRE_MS = 3 * 60_000;
/** A second identical prompt from the same session within this window is a refresh, not new. */
const DEDUPE_MS = 15_000;

export const usePermStore = create<PermState>((set, get) => ({
  items: [],
  unseen: 0,

  push: (p) => {
    // Frontend gate: drop anything that doesn't look like a real interactive
    // approval prompt. The Rust `perm` scanner is intentionally broad (so it
    // catches Claude Code, Codex, Aider, … alike), which means it can also
    // match Claude Code's startup release-notes / changelog banner ("|" table
    // rows, `Documented `claude remote-control`` etc.) and produce noisy
    // "Approval needed" toasts. The INTERACTIVE_RE test here is the *strict*
    // signal of "the program is blocked on the user" — apply it so release
    // notes never reach the bell or the OS toast.
    if (!isWaitingForInput(p.snippet)) {
      return;
    }
    const now = Date.now();
    const live = get().items.filter((i) => now - i.ts < EXPIRE_MS);

    const dup = live.find(
      (i) => i.sessionId === p.sessionId && i.snippet === p.snippet && now - i.ts < DEDUPE_MS,
    );
    if (dup) {
      set({ items: live.map((i) => (i.id === dup.id ? { ...i, ts: p.ts } : i)) });
      return;
    }

    const item: PermItem = { ...p, id: crypto.randomUUID() };
    set({
      items: [item, ...live].slice(0, 40),
      unseen: get().unseen + 1,
    });
  },

  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  markSeen: () => set({ unseen: 0 }),
  clear: () => set({ items: [] }),
}));
