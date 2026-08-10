import { create } from "zustand";

/**
 * A tiny global signal that lets anywhere in the app (the floating "Explain"
 * button on a selection, an "Ask AI" command, a proactive error hint) push a
 * pre-filled prompt into the *inline* terminal composer and optionally fire it
 * immediately — without ever opening the side panel. The composer lives inside
 * the active terminal tab, so this is how the rest of the UI talks to it.
 *
 * `system` optionally carries a one-off system instruction for that request
 * (e.g. the "explain like a senior ops engineer" persona).
 */
interface ComposerState {
  /** Pre-filled text for the inline input, or null when nothing is pending. */
  prefill: string | null;
  /** When true, the composer submits the prefill as soon as it lands. */
  autoSend: boolean;
  /** Optional one-off system instruction for the prefilled request. */
  system: string | null;
  setPrefill: (text: string, autoSend?: boolean, system?: string | null) => void;
  clear: () => void;
}

export const useAiComposer = create<ComposerState>((set) => ({
  prefill: null,
  autoSend: false,
  system: null,
  setPrefill: (text: string, autoSend = false, system: string | null = null) =>
    set({ prefill: text, autoSend, system }),
  clear: () => set({ prefill: null, autoSend: false, system: null }),
}));
