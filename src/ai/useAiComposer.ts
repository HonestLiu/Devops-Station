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
  /** When true, the inline answer panel auto-expands to surface an automatic
   *  diagnosis even if the operator never manually opened the composer. */
  revealAnswer: boolean;
  /**
   * Session whose latest assistant message the inline bar should surface.
   * Used by auto-diagnose: the diagnosis is streamed into a transient session,
   * and the inline bar is pointed at it so the answer appears in the terminal
   * without polluting the user's chat history.
   */
  displaySessionId: string | null;
  setPrefill: (text: string, autoSend?: boolean, system?: string | null) => void;
  setRevealAnswer: (v: boolean) => void;
  setDisplaySessionId: (id: string | null) => void;
  clear: () => void;
}

export const useAiComposer = create<ComposerState>((set) => ({
  prefill: null,
  autoSend: false,
  system: null,
  revealAnswer: false,
  displaySessionId: null,
  setPrefill: (text: string, autoSend = false, system: string | null = null) =>
    set({ prefill: text, autoSend, system }),
  setRevealAnswer: (v: boolean) => set({ revealAnswer: v }),
  setDisplaySessionId: (id: string | null) => set({ displaySessionId: id }),
  clear: () =>
    set({ prefill: null, autoSend: false, system: null, displaySessionId: null }),
}));
