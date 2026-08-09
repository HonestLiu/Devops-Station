import { ssh, pty, serial } from "@/lib/api";
import { textToBase64 } from "@/lib/utils";
import { useAiStore } from "./useAiStore";
import { useTerminalSelection } from "./terminalBridge";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab, TabKind } from "@/lib/types";

interface ActiveTerminal {
  tab: Tab;
  sessionId: string;
  kind: TabKind;
}

function getActiveTerminal(): ActiveTerminal | null {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  // SFTP-only tabs have no terminal to write into.
  if (!tab || !tab.sessionId || tab.kind === "sftp") return null;
  return { tab, sessionId: tab.sessionId, kind: tab.kind };
}

/**
 * Write a command to the active terminal. With `execute`, a terminator is
 * appended so the command actually runs:
 *   - shells (ssh / pty): `\r` (the Enter key as produced by xterm onData)
 *   - serial: the port's configured line ending (falls back to `\r`)
 * Without `execute`, the text is typed at the prompt for the operator to review
 * before pressing Enter — the "safe" default for AI-generated commands.
 */
export function writeToTerminal(cmd: string, execute: boolean): void {
  const t = getActiveTerminal();
  if (!t || !cmd) return;
  const { tab, sessionId, kind } = t;

  let data = cmd;
  if (execute) {
    // Shells end a command with Enter (`\r`); serial uses the configured line
    // ending, but that lives in component state, so fall back to `\r` here.
    const terminator = kind === "serial" ? "\r" : "\r";
    data = cmd + terminator;
  }

  const writer =
    kind === "ssh" ? ssh.write : kind === "serial" ? serial.write : pty.write;
  void writer(sessionId, textToBase64(data));
}

const EXPLAIN_SYSTEM =
  "You are a senior Linux / embedded ops engineer. The user selected text from their terminal. " +
  "If it is a shell command, explain concisely what it does, its key flags, and any risks " +
  "(e.g. destructive rm, reboot, chmod 777). If it is command output, summarize what it shows. " +
  "Use short bullet points, under 180 words.";

const GENERATE_SYSTEM =
  "You are a Linux / ops command generator. Return ONLY the shell command(s) the user needs, " +
  "as a single fenced bash code block, with no extra prose or explanation. If multiple " +
  "commands are required, put them on separate lines inside the one block. Prefer safe, " +
  "idempotent commands and avoid destructive actions unless explicitly requested.";

/** Explain the currently-selected terminal text in the AI panel. */
export function explainSelection(): void {
  const text = useTerminalSelection.getState().text.trim();
  if (!text) return;
  const message = `Explain the following terminal selection:\n\n${text}`;
  const store = useAiStore.getState();
  store.togglePanel(true);
  void store.send(message, { title: "Explain selection", system: EXPLAIN_SYSTEM });
}

/** Generate a command from a natural-language request and stream it to the panel. */
export function generateCommand(prompt: string): void {
  const p = prompt.trim();
  if (!p) return;
  const store = useAiStore.getState();
  store.togglePanel(true);
  void store.send(p, { title: "Generate command", system: GENERATE_SYSTEM });
}
