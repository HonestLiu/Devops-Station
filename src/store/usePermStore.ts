import { create } from "zustand";

import { isWaitingForInput } from "@/ai/errorScan";
import { permHook } from "@/lib/api";
import { useTabsStore } from "@/store/useTabsStore";
import { useSessionStore } from "@/store/useSessionStore";

export interface PermItem {
  id: string;
  /** Session id reported by the backend — for HOOK events this is the agent
   *  CLI's own session id, which has no relation to our local pty sessions. */
  sessionId: string;
  /** Local terminal session the prompt was associated with (HOOK events are
   *  linked to the tab that was active when the request arrived). `undefined`
   *  when no terminal was active. */
  targetSessionId?: string;
  tool: string;
  snippet: string;
  /** Detection timestamp (epoch ms). */
  ts: number;
  /** `"hook"` (tool's own permission hook — exact) or `"scan"` (legacy regex). */
  source: "hook" | "scan";
}

interface PermState {
  items: PermItem[];
  unseen: number;
  /** Add a detected request; de-dupes repeats from the same session. */
  push: (p: Omit<PermItem, "id">) => void;
  dismiss: (id: string) => void;
  markSeen: () => void;
  clear: () => void;
  /** The most recent approval event and the local session it was linked to —
   *  drives the quick-approve shortcut when no session is text-flagged. */
  lastApproval: { sessionId: string; ts: number } | null;
}

/** Requests older than this are auto-dropped — a stale prompt has long since resolved. */
const EXPIRE_MS = 3 * 60_000;
/**
 * One approval per session per this window, no matter how many times the
 * backend re-detects the same TUI prompt (it re-renders on every keystroke).
 * The backend already dedupes by signature, but a frame that changes enough to
 * produce a different signature every keypress would otherwise flood the bell.
 * SCAN-source only: HOOK events are precise one-shot notifications and must
 * NOT be collapsed by this window (see push).
 */
const SESSION_WINDOW_MS = 30_000;
/** A dismissed entry stays "seen" for this long, so a re-detected prompt that
 *  the user already closed doesn't immediately come back. SCAN-source only. */
const DISMISSED_MS = 30_000;
/**
 * HOOK-source dedup window: the tool fires the event once per approval, so the
 * only thing this guards against is a near-identical duplicate POST (a hook
 * running twice, the plugin re-emitting the same ask). Anything more would
 * swallow a *second, real* approval of the same command in the same session —
 * the exact "bell only shows the first one" report.
 */
const HOOK_DEDUP_MS = 2_500;

/** Collapse a prompt into a stable identity: whitespace/digits/quoted values
 *  vary across TUI redraws, the question text does not. */
function fingerprint(snippet: string): string {
  return snippet
    .replace(/\s+/g, " ")
    .replace(/[0-9]+/g, "#")
    .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
    .replace(/'(?:[^'\\]|\\.)*'/g, "'…'")
    .trim()
    .slice(0, 120)
    .toLowerCase();
}

/**
 * The local terminal session the user is currently working in — the most
 * plausible owner of a just-arrived approval request. `tab.sessionId` stays in
 * sync with the focused pane (see useTabsStore.focusPane), so this resolves
 * split tabs correctly. Returns undefined for non-terminal tabs (SFTP, J-Link).
 */
export function resolveLocalSession(): string | undefined {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  return tab?.sessionId || undefined;
}

/** Last-seen per (session, fingerprint) — first detection in the window wins. */
const lastSeen = new Map<string, number>();
/** Fingerprints the user dismissed — suppressed until the window lapses. */
const dismissed = new Map<string, number>();

export const usePermStore = create<PermState>((set, get) => ({
  items: [],
  unseen: 0,
  lastApproval: null,

  push: (p) => {
    // Frontend gate — only for the legacy SCAN source. A scan matches on
    // "approval-shaped" output and can fire on banners / release notes / plain
    // text, so we require the strict "blocked on the user" signal
    // (INTERACTIVE_RE). HOOK-sourced events are emitted by the tool itself the
    // moment it needs approval — they are exact by construction and must NOT
    // be filtered (a hook snippet is the command, which usually contains no
    // interactive-prompt marker).
    if (p.source !== "hook" && !isWaitingForInput(p.snippet)) {
      return;
    }

    const now = Date.now();
    const fp = fingerprint(p.snippet);

    // Opportunistically drop expired dedup/dismiss entries (bounded memory).
    for (const [k, ts] of dismissed) {
      if (ts < now - DISMISSED_MS) dismissed.delete(k);
    }
    for (const [k, ts] of lastSeen) {
      if (ts < now - 60_000) lastSeen.delete(k);
    }

    if (p.source === "hook") {
      // Precise event from the tool itself: every approval must reach the bell.
      // Only collapse a true duplicate emission within a sub-second window.
      const dupKey = `h|${p.sessionId}|${fp}`;
      const prevDup = lastSeen.get(dupKey) ?? 0;
      if (now - prevDup < HOOK_DEDUP_MS) return;
      lastSeen.set(dupKey, now);
    } else {
      // SCAN source: legacy heuristics. Strict prompt gate already applied
      // above; additionally ignore re-detections of a prompt the user already
      // handled (dismissed) or within the per-session flood window (TUI
      // redraws re-emit the same frame many times).
      const sessionKey = `${p.sessionId}|${fp}`;
      if ((dismissed.get(sessionKey) ?? 0) > now - DISMISSED_MS) return;
      const prev = lastSeen.get(sessionKey) ?? 0;
      if (now - prev < SESSION_WINDOW_MS) return;
      lastSeen.set(sessionKey, now);
    }

    // Link the request to a local terminal session: the tab that was active
    // when it arrived is the one running the agent CLI (a hook's session id is
    // the agent's own, useless for targeting our pty). When linked, mark the
    // session as "waiting" so the tab badge and the quick-approve shortcut
    // (which need a local session id) light up immediately — the text scanner
    // may never flag agent TUIs whose prompt text doesn't match INTERACTIVE_RE.
    const targetSessionId = resolveLocalSession();
    if (targetSessionId) {
      useSessionStore.getState().markHookWaiting(targetSessionId);
    }

    const live = get().items.filter((i) => now - i.ts < EXPIRE_MS);
    const item: PermItem = { ...p, targetSessionId, id: crypto.randomUUID() };
    set({
      items: [item, ...live].slice(0, 40),
      unseen: get().unseen + 1,
      lastApproval: targetSessionId
        ? { sessionId: targetSessionId, ts: now }
        : get().lastApproval,
    });
  },

  dismiss: (id) => {
    const item = get().items.find((i) => i.id === id);
    if (item) {
      // Remember what was dismissed so the same prompt re-detected during the
      // window (TUI still on screen) doesn't pop straight back.
      const key = `${item.sessionId}|${fingerprint(item.snippet)}`;
      dismissed.set(key, Date.now());
      // Dismissing the entry means the user has dealt with it — tell the backend
      // so escalation stops and the traffic-light entry clears.
      void permHook.ack(item.sessionId).catch(() => undefined);
      // Clear the tab's "waiting" badge (and hook marker) so the hourglass
      // doesn't linger.
      if (item.targetSessionId) {
        useSessionStore.getState().markSettled(item.targetSessionId);
      }
    }
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },

  markSeen: () => set({ unseen: 0 }),
  clear: () => {
    // Clearing the list counts as dismissing everything in it.
    const now = Date.now();
    for (const i of get().items) {
      dismissed.set(`${i.sessionId}|${fingerprint(i.snippet)}`, now);
      void permHook.ack(i.sessionId).catch(() => undefined);
    }
    set({ items: [], unseen: 0 });
  },
}));
