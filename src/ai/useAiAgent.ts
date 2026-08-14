import { create } from "zustand";

/**
 * Holds the live state of an inline agent run so the terminal can render the
 * agent's progress as a compact, same-view block instead of opening the side
 * panel. The autonomous loop in `agent.ts` feeds steps here when launched from
 * the inline composer (`inline: true`).
 */
export interface AgentStep {
  /** The shell command the model proposed. */
  cmd: string;
  /** Terminal output captured after running it (may be empty). */
  result: string;
  /** Outcome used to colour the step in the UI. */
  status: "ok" | "empty" | "error";
}

interface AiAgentState {
  running: boolean;
  goal: string;
  steps: AgentStep[];
  error: string | null;
  /** The model's final natural-language conclusion (text after `DONE:`). */
  summary: string | null;
  setRunning: (v: boolean) => void;
  setGoal: (g: string) => void;
  pushStep: (s: AgentStep) => void;
  setError: (e: string | null) => void;
  setSummary: (s: string | null) => void;
  reset: () => void;
}

export const useAiAgent = create<AiAgentState>((set) => ({
  running: false,
  goal: "",
  steps: [],
  error: null,
  summary: null,
  setRunning: (v) => set({ running: v }),
  setGoal: (g) => set({ goal: g }),
  pushStep: (s) => set((st) => ({ steps: [...st.steps, s] })),
  setError: (e) => set({ error: e }),
  setSummary: (s) => set({ summary: s }),
  reset: () => set({ running: false, goal: "", steps: [], error: null, summary: null }),
}));
