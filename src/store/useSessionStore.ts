import { create } from "zustand";

interface SessionState {
  /** Remote working directory reported by the shell (keyed by session id). */
  cwdBySession: Record<string, string>;
  /** Record the directory the shell is currently in. */
  setCwd: (sessionId: string, cwd: string) => void;
  /** Drop a session's cached directory (e.g. on disconnect). */
  clearCwd: (sessionId: string) => void;
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
}));
