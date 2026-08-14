import { create } from "zustand";

export interface Suggestion {
  sessionId: string;
  /** Short human label, e.g. "Connection refused". */
  label: string;
  /** The offending line(s), capped, for the fix prompt. */
  snippet: string;
  ts: number;
}

interface SuggestionState {
  current: Suggestion | null;
  /** Offer a suggestion. Deduplicated by error fingerprint over a window. */
  offer: (s: Omit<Suggestion, "ts">) => void;
  clear: () => void;
}

/**
 * Primary deduplication happens in the terminal detection layer
 * (Terminal.tsx → shouldHandleError, keyed on error fingerprint, 60s window).
 * This store keeps its own fingerprint window purely as a safety net for any
 * other future call site — the old (sessionId, label) cooldown keyed on the
 * session id, so reconnecting (a new session id) re-triggered the same error.
 */
const ERROR_DEDUP_WINDOW_MS = 60_000;
const lastShown = new Map<string, number>();

export const useAiSuggestion = create<SuggestionState>((set) => ({
  current: null,
  offer: (s) => {
    const fp = `${s.label}|${s.snippet.replace(/\s+/g, " ").replace(/[0-9]+/g, "#").trim().slice(0, 120)}`;
    const now = Date.now();
    const prev = lastShown.get(fp) ?? 0;
    if (now - prev < ERROR_DEDUP_WINDOW_MS) return;
    lastShown.set(fp, now);
    if (lastShown.size > 128) {
      for (const [k, ts] of lastShown) {
        if (now - ts >= ERROR_DEDUP_WINDOW_MS) lastShown.delete(k);
      }
    }
    set({ current: { ...s, ts: now } });
  },
  clear: () => set({ current: null }),
}));
