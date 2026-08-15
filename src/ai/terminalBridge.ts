import { create } from "zustand";
import type { Terminal as XTerm } from "@xterm/xterm";
import { useTabsStore } from "@/store/useTabsStore";

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

/** Give keyboard focus to a specific terminal (no-op when it isn't mounted). */
export function focusTerminal(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  registry.get(sessionId)?.focus();
}

/**
 * Focus the terminal the user is currently working in: the active tab's
 * session (`tab.sessionId` tracks the focused pane, so split tabs resolve
 * correctly). Used to restore focus when the window regains it (Alt+Tab) and
 * after tab switches, so typing works immediately without a click.
 */
export function focusActiveTerminal(): void {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  if (tab?.sessionId) focusTerminal(tab.sessionId);
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

/**
 * Number of lines *with real content* currently in the terminal buffer, i.e. the
 * cursor's absolute line index (`baseY + cursorY`).
 *
 * IMPORTANT: we must NOT use `buffer.active.length` here. xterm pre-fills the
 * buffer with `rows` empty lines, so during the early life of a session (fewer
 * lines of output than the viewport height) `length` stays pinned at `rows` and
 * never grows — a snapshot taken before a short command (e.g. `find` printing a
 * single line) would equal the post-command `length`, and `getTerminalTail`
 * would return "" → the agent reports "(无输出)" even though the command ran.
 * The cursor's absolute line is the last line that actually holds content.
 *
 * Snapshot this *before* writing a command so the agent loop can later read only
 * what the command produced (see `getTerminalTail`) — instead of re-feeding the
 * entire scrollback on every step, which is what made the model re-issue the
 * same command.
 */
export function getTerminalLineCount(sessionId: string): number {
  const term = registry.get(sessionId);
  if (!term) return 0;
  const buf = term.buffer.active;
  return buf.baseY + buf.cursorY;
}

/**
 * Return only the lines appended to the terminal from `fromLine` onward, up to
 * the cursor's current absolute line (the last content line). Because the cursor
 * line index is captured before the command and xterm grows the buffer as output
 * streams in, reading from that snapshot isolates exactly the command's echo +
 * output — the unambiguous "tool result" the agent needs.
 *
 * `fromLine` is the pre-command cursor line; `baseY` is only used to compute the
 * end so we never walk into xterm's empty filler rows below the cursor.
 */
export function getTerminalTail(sessionId: string, fromLine: number): string {
  const term = registry.get(sessionId);
  if (!term) return "";
  const buf = term.buffer.active;
  const end = buf.baseY + buf.cursorY + 1; // content ends at the cursor line (inclusive)
  const start = Math.max(0, fromLine);
  if (start >= end) return "";
  const lines: string[] = [];
  for (let i = start; i < end; i += 1) {
    const line = buf.getLine(i);
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
