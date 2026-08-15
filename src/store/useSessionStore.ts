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
}

/** How long a hook-sourced "waiting" marker stays authoritative. */
export const HOOK_WAITING_TTL_MS = 30_000;

/**
 * Tracks the remote shell's current working directory per session. The terminal
 * (xterm OSC 7 handler) writes here; the SFTP panel reads it to auto-follow the
 * directory the user `cd`s into.
 */
export const useSessionStore = create<SessionState>((set) => ({
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
  markHookWaiting: (sessionId) =>
    set((s) => {
      const until = Date.now() + HOOK_WAITING_TTL_MS;
      if (s.hookWaitingBySession[sessionId] === until) return s;
      return {
        hookWaitingBySession: { ...s.hookWaitingBySession, [sessionId]: until },
        // Also flip the waiting flag on immediately.
        waitingBySession: { ...s.waitingBySession, [sessionId]: true },
      };
    }),
  clearHookWaiting: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.hookWaitingBySession)) return s;
      const next = { ...s.hookWaitingBySession };
      delete next[sessionId];
      return { hookWaitingBySession: next };
    }),
}));
