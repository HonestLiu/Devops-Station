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
  /** Offer a suggestion. Deduplicated per (session, label) over a cooldown. */
  offer: (s: Omit<Suggestion, "ts">) => void;
  clear: () => void;
}

// Module-level so it never gets serialized / reset by React.
const lastSeen = new Map<string, number>();
const COOLDOWN_MS = 30_000;

export const useAiSuggestion = create<SuggestionState>((set) => ({
  current: null,
  offer: (s) => {
    const now = Date.now();
    const key = `${s.sessionId}|${s.label}`;
    const prev = lastSeen.get(key) ?? 0;
    if (now - prev < COOLDOWN_MS) return;
    lastSeen.set(key, now);
    set({ current: { ...s, ts: now } });
  },
  clear: () => set({ current: null }),
}));
