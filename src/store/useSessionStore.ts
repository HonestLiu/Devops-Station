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
}

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
      const cur = s.waitingBySession[sessionId] ?? false;
      if (cur === waiting) return s;
      const next = { ...s.waitingBySession };
      if (waiting) next[sessionId] = true;
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
}));
