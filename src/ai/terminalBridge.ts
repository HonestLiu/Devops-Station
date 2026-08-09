import { create } from "zustand";
import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * Bridges the per-session xterm instances (which live inside the Terminal
 * component) to the rest of the app. The Terminal AI features need a handle to
 * read the current selection ("explain selected command") and nothing more —
 * input is always sent through the existing pty / ssh / serial APIs.
 */

const registry = new Map<string, XTerm>();

export function registerTerminal(sessionId: string, term: XTerm): void {
  registry.set(sessionId, term);
}

export function unregisterTerminal(sessionId: string): void {
  registry.delete(sessionId);
}

export function getTerminal(sessionId: string): XTerm | undefined {
  return registry.get(sessionId);
}

/**
 * Read the visible + scrollback text of a terminal session by walking xterm's
 * buffer line by line. Used by the "analyze log" / "analyze terminal" actions so
 * we can feed the on-screen output to the AI without a dedicated addon.
 */
export function getTerminalText(sessionId: string, maxLines = 4000): string {
  const term = registry.get(sessionId);
  if (!term) return "";
  const buffer = term.buffer.active;
  const total = buffer.length;
  const start = Math.max(0, total - maxLines);
  const lines: string[] = [];
  for (let i = start; i < total; i += 1) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface SelectionState {
  text: string;
  sessionId: string | null;
  setText: (text: string, sessionId: string | null) => void;
  clear: () => void;
}

/**
 * Tracks the most recent terminal selection. `sessionId` lets the UI show the
 * "Explain" affordance only on the terminal that actually owns the selection.
 */
export const useTerminalSelection = create<SelectionState>((set) => ({
  text: "",
  sessionId: null,
  setText: (text, sessionId) => set({ text, sessionId }),
  clear: () => set({ text: "", sessionId: null }),
}));
