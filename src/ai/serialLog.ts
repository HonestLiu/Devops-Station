import { create } from "zustand";

/**
 * Holds a rolling window of recent serial RX text so the "parse protocol" AI
 * action can read what the user is seeing. The SerialWorkspace appends to it;
 * the AI task reads it. Kept as plain text (not the structured log entries) so
 * it is trivial to hand to the model.
 */

const MAX_CHARS = 32_000;

interface SerialLogState {
  text: string;
  push: (s: string) => void;
  clear: () => void;
}

export const useSerialLog = create<SerialLogState>((set) => ({
  text: "",
  push: (s) =>
    set((state) => {
      const next = state.text + s;
      return { text: next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next };
    }),
  clear: () => set({ text: "" }),
}));
