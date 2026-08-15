import { create } from "zustand";

interface SessionState {
  /** Remote working directory reported by the shell (keyed by session id). */
  cwdBySession: Record<string, string>;
  /** Record the directory the shell is currently in. */
  setCwd: (sessionId: string, cwd: string) => void;
  /** Drop a session's cached directory (e.g. on disconnect). */
  clearCwd: (sessionId: string) => void;
  /** Sessions currently blocked waiting for the user's input (e.g. an agent
   *  CLI's approval prompt). Drives the "waiting for input" tab badge + hint. */
  waitingBySession: Record<string, boolean>;
  /** Mark/unmark a session as waiting for input. */
  setWaiting: (sessionId: string, waiting: boolean) => void;
  /** Clear the waiting flag for a session (e.g. on disconnect). */
  clearWaiting: (sessionId: string) => void;
  /**
   * Hard "waiting" markers from the approval HOOK channel (epoch ms per
   * session). A tool's permission hook fires exactly when it blocks on the
   * user, so this overrides the terminal-text heuristic: `setWaiting(sid,
   * false)` from the text scanner is ignored while a fresh hook marker exists,
   * keeping the tab badge and the quick-approve shortcut live for the whole
   * TTL even for prompts whose text doesn't match the regex.
   */
  hookWaitingBySession: Record<string, number>;
  /** Set the hook marker for a session (now + TTL). */
  markHookWaiting: (sessionId: string) => void;
  /** Drop the hook marker for a session. */
  clearHookWaiting: (sessionId: string) => void;
  /**
   * Timestamps of sessions the user has explicitly handled (approved /
   * rejected / dismissed the bell entry). While recent, the text heuristic is
   * suppressed from re-flagging the session: agent TUIs redraw in place, so the
   * approval wording can linger in the scroll tail long after the prompt was
   * answered, and without this the badge would flicker straight back on.
   */
  settledBySession: Record<string, number>;
  /**
   * Mark a session as handled: clears the hook marker and the waiting flag, and
   * suppresses text-heuristic re-flags for a short window.
   */
  markSettled: (sessionId: string) => void;
}

/** How long a hook-sourced "waiting" marker stays authoritative. */
export const HOOK_WAITING_TTL_MS = 30_000;
/** After the user handles a prompt, ignore text-heuristic re-flags this long. */
const SETTLED_SUPPRESS_MS = 10_000;

/**
 * Auto-clear timers for hook markers. The text scanner flips its own
 * `waitingRef` the moment the approval wording scrolls out of its tail, so it
 * will never call `setWaiting(sid, false)` again — without a timer the hook
 * marker would expire but leave `waitingBySession[sid] = true` orphaned, and
 * the tab badge would show the hourglass forever (the reported bug).
 */
const hookTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Tracks the remote shell's current working directory per session. The terminal
 * (xterm OSC 7 handler) writes here; the SFTP panel reads it to auto-follow the
 * directory the user `cd`s into.
 */
export const useSessionStore = create<SessionState>((set, get) => ({
  cwdBySession: {},
  setCwd: (sessionId, cwd) =>
    set((s) => {
      if (s.cwdBySession[sessionId] === cwd) return s;
      return { cwdBySession: { ...s.cwdBySession, [sessionId]: cwd } };
    }),
  clearCwd: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.cwdBySession)) return s;
      const next = { ...s.cwdBySession };
      delete next[sessionId];
      return { cwdBySession: next };
    }),
  waitingBySession: {},
  setWaiting: (sessionId, waiting) =>
    set((s) => {
      if (waiting) {
        // The user just handled this prompt (approved / rejected / dismissed):
        // suppress text-heuristic re-flags for a short window so the badge
        // doesn't flicker back on from approval wording still in the scroll
        // tail. A brand-new HOOK event still lights it (markHookWaiting).
        if ((s.settledBySession[sessionId] ?? 0) > Date.now() - SETTLED_SUPPRESS_MS) {
          return s;
        }
      }
      // A fresh HOOK marker wins over the text heuristic: the tool itself said
      // it's blocked, so the scanner's "no prompt text right now" must not
      // clear the badge while the marker is still authoritative.
      const hookUntil = s.hookWaitingBySession[sessionId] ?? 0;
      const hookLive = hookUntil > Date.now();
      const final = waiting || hookLive;
      const cur = s.waitingBySession[sessionId] ?? false;
      if (cur === final) return s;
      const next = { ...s.waitingBySession };
      if (final) next[sessionId] = true;
      else delete next[sessionId];
      return { waitingBySession: next };
    }),
  clearWaiting: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.waitingBySession)) return s;
      const next = { ...s.waitingBySession };
      delete next[sessionId];
      return { waitingBySession: next };
    }),
  hookWaitingBySession: {},
  markHookWaiting: (sessionId) => {
    set((s) => {
      const until = Date.now() + HOOK_WAITING_TTL_MS;
      if (s.hookWaitingBySession[sessionId] === until) return s;
      return {
        hookWaitingBySession: { ...s.hookWaitingBySession, [sessionId]: until },
        // Also flip the waiting flag on immediately.
        waitingBySession: { ...s.waitingBySession, [sessionId]: true },
      };
    });
    // Schedule the authoritative window to end: clear the marker and drop the
    // waiting flag (the text scanner won't re-call setWaiting once its own ref
    // flipped). If the prompt is genuinely still on screen, the scanner
    // re-flags it on the next output chunk.
    const existing = hookTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    hookTimers.set(
      sessionId,
      setTimeout(() => {
        hookTimers.delete(sessionId);
        const st = useSessionStore.getState();
        st.clearHookWaiting(sessionId);
        st.clearWaiting(sessionId);
      }, HOOK_WAITING_TTL_MS),
    );
  },
  clearHookWaiting: (sessionId) => {
    const timer = hookTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      hookTimers.delete(sessionId);
    }
    set((s) => {
      if (!(sessionId in s.hookWaitingBySession)) return s;
      const next = { ...s.hookWaitingBySession };
      delete next[sessionId];
      return { hookWaitingBySession: next };
    });
  },
  settledBySession: {},
  markSettled: (sessionId) => {
    get().clearHookWaiting(sessionId);
    get().clearWaiting(sessionId);
    set((s) => {
      if (s.settledBySession[sessionId] !== undefined) return s;
      return { settledBySession: { ...s.settledBySession, [sessionId]: Date.now() } };
    });
  },
}));
