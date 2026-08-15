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
  /**
   * One-shot signal asking the floating selection menu to open its free-form
   * "ask" input (e.g. triggered from the terminal's right-click menu). Consumed
   * (reset to false) by the menu once it opens the input.
   */
  requestAsk: boolean;
  /**
   * Terminal selection to ask about, captured by `openAsk(text)` so the ask box
   * still has its context even after focusing the input clears the xterm
   * selection.
   */
  askContext: string | null;
  setPrefill: (text: string, autoSend?: boolean, system?: string | null) => void;
  setRevealAnswer: (v: boolean) => void;
  setDisplaySessionId: (id: string | null) => void;
  openAsk: (text?: string) => void;
  consumeAsk: () => void;
  clear: () => void;
}

export const useAiComposer = create<ComposerState>((set) => ({
  prefill: null,
  autoSend: false,
  system: null,
  revealAnswer: false,
  displaySessionId: null,
  requestAsk: false,
  askContext: null,
  setPrefill: (text: string, autoSend = false, system: string | null = null) =>
    set({ prefill: text, autoSend, system }),
  setRevealAnswer: (v: boolean) => set({ revealAnswer: v }),
  setDisplaySessionId: (id: string | null) => set({ displaySessionId: id }),
  openAsk: (text?: string) => set({ requestAsk: true, askContext: text ?? null }),
  consumeAsk: () => set({ requestAsk: false, askContext: null }),
  clear: () =>
    set({
      prefill: null,
      autoSend: false,
      system: null,
      displaySessionId: null,
      requestAsk: false,
      askContext: null,
    }),
}));
