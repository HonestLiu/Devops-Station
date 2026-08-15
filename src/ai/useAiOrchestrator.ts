import { create } from "zustand";

import type { AgentStep } from "./useAiAgent";

/**
 * Holds the live state of a multi-host agent run. Unlike the single-host
 * `useAiAgent` (which drives one terminal and shows a compact block inside it),
 * the orchestrator fans a single goal out to several terminal sessions at once
 * and aggregates their results — so it needs per-host progress + a final
 * cross-host synthesis.
 */
export type HostStatus = "pending" | "running" | "done" | "error";

export interface OrchestratorHost {
  sessionId: string;
  label: string;
  kind: string;
  status: HostStatus;
  steps: AgentStep[];
  /** Raw tool-result transcript captured from this host's terminal. */
  finalOutput: string;
  /** The model's `DONE:` summary for this host, if any. */
  summary: string;
  error: string | null;
}

interface AiOrchestratorState {
  running: boolean;
  goal: string;
  hosts: OrchestratorHost[];
  /** Final AI-generated comparison across all hosts. */
  synthesis: string | null;

  start: (goal: string, hosts: { sessionId: string; label: string; kind: string }[]) => void;
  reset: () => void;
  setRunning: (v: boolean) => void;
  setHostStatus: (sessionId: string, status: HostStatus) => void;
  pushStep: (sessionId: string, step: AgentStep) => void;
  setHostResult: (
    sessionId: string,
    r: { finalOutput: string; summary: string; error: string | null },
  ) => void;
  setSynthesis: (s: string | null) => void;
}

export const useAiOrchestrator = create<AiOrchestratorState>((set) => ({
  running: false,
  goal: "",
  hosts: [],
  synthesis: null,

  start: (goal, hosts) =>
    set({
      running: true,
      goal,
      synthesis: null,
      hosts: hosts.map((h) => ({
        ...h,
        status: "pending",
        steps: [],
        finalOutput: "",
        summary: "",
        error: null,
      })),
    }),

  reset: () => set({ running: false, goal: "", hosts: [], synthesis: null }),

  setRunning: (v) => set({ running: v }),

  setHostStatus: (sessionId, status) =>
    set((st) => ({
      hosts: st.hosts.map((h) => (h.sessionId === sessionId ? { ...h, status } : h)),
    })),

  pushStep: (sessionId, step) =>
    set((st) => ({
      hosts: st.hosts.map((h) =>
        h.sessionId === sessionId ? { ...h, steps: [...h.steps, step] } : h,
      ),
    })),

  setHostResult: (sessionId, r) =>
    set((st) => ({
      hosts: st.hosts.map((h) =>
        h.sessionId === sessionId
          ? { ...h, status: r.error ? "error" : "done", finalOutput: r.finalOutput, summary: r.summary, error: r.error }
          : h,
      ),
    })),

  setSynthesis: (s) => set({ synthesis: s }),
}));
