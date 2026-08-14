import { ssh, pty, serial } from "@/lib/api";
import { dataLink } from "@/lib/dataLink";
import { textToBase64 } from "@/lib/utils";
import { tFrom } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { useAiStore } from "./useAiStore";
import { useAiComposer } from "./useAiComposer";
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
 * Resolve which terminal session a command should be written to.
 *
 * When `pinned` is given (the session the agent was launched from, e.g. the
 * focused split pane), we use it directly — this is what makes "run in the
 * terminal I'm looking at" reliable instead of always falling back to the
 * global `activeId` (which can be a different tab, or null for an SFTP tab,
 * leaving the command to only appear in the bottom agent block).
 */
function resolveTarget(pinned?: string | null): { sessionId: string; kind: TabKind } | null {
  const state = useTabsStore.getState();
  if (pinned) {
    for (const tab of state.tabs) {
      if (tab.sessionId && tab.sessionId === pinned) {
        return { sessionId: tab.sessionId, kind: tab.kind };
      }
      const pane = tab.panes?.find((p) => p.sessionId === pinned);
      if (pane && pane.sessionId) return { sessionId: pane.sessionId, kind: tab.kind };
    }
    return null;
  }
  return getActiveTerminal();
}

/** Resolve the destination session id, or null when there is no usable shell. */
export function getTargetSession(pinned?: string | null): string | null {
  return resolveTarget(pinned)?.sessionId ?? null;
}

/**
 * Resolve the *tab* the agent should act on. Used to describe the terminal type
 * (OS / shell / serial) for the model so it can adapt its command syntax.
 */
function findTargetTab(pinned?: string | null): Tab | null {
  const state = useTabsStore.getState();
  if (pinned) {
    for (const tab of state.tabs) {
      if (tab.sessionId && tab.sessionId === pinned) return tab;
      const p = tab.panes?.find((pp) => pp.sessionId === pinned);
      if (p) return tab;
    }
    return null;
  }
  return getActiveTerminal()?.tab ?? null;
}

/** Best-effort shell-family label from the resolved shell path. */
function shellFamily(shell?: string): string {
  if (!shell) return "the default login shell";
  const s = shell.toLowerCase();
  if (s.includes("pwsh")) return "PowerShell (pwsh)";
  if (s.includes("powershell")) return "Windows PowerShell";
  if (s.includes("cmd.exe") || s === "cmd") return "Command Prompt (cmd.exe)";
  if (s.includes("bash")) return "Bash";
  if (s.includes("zsh")) return "Zsh";
  if (s.includes("fish")) return "Fish";
  if (s.includes("sh")) return "POSIX sh";
  if (s.endsWith(".exe")) return "a Windows executable shell";
  return shell;
}

/**
 * Human-readable description of the terminal the agent is about to drive, injected
 * as a system message so the model picks the right syntax (PowerShell vs bash vs
 * serial AT commands) and the right OS conventions (Windows paths vs Unix).
 */
export function getTerminalTypeDescription(pinned?: string | null): string {
  const tab = findTargetTab(pinned);
  if (!tab) {
    return "TERMINAL ENVIRONMENT: none — there is no open terminal to run commands in.";
  }

  const parts: string[] = [];
  switch (tab.kind) {
    case "ssh": {
      const cfg = tab.sshConfig;
      const host = cfg?.hostname ?? tab.subtitle ?? "the remote host";
      const user = cfg?.username ? `${cfg.username}@` : "";
      const port = cfg?.port && cfg.port !== 22 ? `:${cfg.port}` : "";
      parts.push(
        `TERMINAL ENVIRONMENT: a remote shell over SSH on ${user}${host}${port}. ` +
          `Assume a Linux/Unix host with a POSIX shell (bash/sh) unless the output shows otherwise. ` +
          `Use Unix command syntax and forward slashes for paths.`,
      );
      break;
    }
    case "wsl": {
      const distro = tab.wsl?.distro ? ` (WSL distro: ${tab.wsl.distro})` : " (default WSL distro)";
      parts.push(
        `TERMINAL ENVIRONMENT: a Linux shell inside WSL${distro}. ` +
          `Use Linux commands; Windows drives are mounted under /mnt/c, /mnt/d, etc.`,
      );
      break;
    }
    case "local": {
      const fam = shellFamily(tab.shell);
      const isWin =
        !tab.shell ||
        /\.exe$/i.test(tab.shell) ||
        /pwsh|powershell|cmd\.exe/i.test(tab.shell);
      const os = isWin ? "Windows" : "Linux/Unix (or macOS)";
      parts.push(
        `TERMINAL ENVIRONMENT: a LOCAL ${os} shell (${fam}). ` +
          (isWin
            ? "Prefer PowerShell/cmd syntax as appropriate; be careful with Windows path quoting and backslashes."
            : "Use Unix command syntax and forward slashes for paths."),
      );
      break;
    }
    case "frp": {
      parts.push(
        `TERMINAL ENVIRONMENT: an SSH session tunneled through an FRP reverse proxy to a remote host. ` +
          `Treat it like a remote Linux/Unix shell over SSH.`,
      );
      break;
    }
    case "serial": {
      const s = tab.serial;
      const port = s?.port ?? tab.subtitle ?? "the serial port";
      const baud = s?.baudRate ? ` at ${s.baudRate} baud` : "";
      parts.push(
        `TERMINAL ENVIRONMENT: a RAW SERIAL console on ${port}${baud}. ` +
          `There is NO shell — send device / AT / CLI commands directly; line endings matter (default CR). ` +
          `Do NOT use shell built-ins, pipes, or redirection unless the device firmware supports them.`,
      );
      break;
    }
    case "ble": {
      parts.push(
        `TERMINAL ENVIRONMENT: a Bluetooth Low Energy serial bridge (GATT). ` +
          `There is NO shell — send raw commands or hex per the device's protocol.`,
      );
      break;
    }
    default:
      parts.push(`TERMINAL ENVIRONMENT: a terminal of type ${tab.kind}.`);
  }
  if (tab.cwd) parts.push(`Current working directory: ${tab.cwd}.`);
  return parts.join(" ");
}

function writerFor(kind: TabKind) {
  if (kind === "ssh") return ssh.write;
  if (kind === "serial") return serial.write;
  if (kind === "ble") return dataLink("ble").write;
  return pty.write;
}

/**
 * Write a command to a terminal. With `execute`, a `\r` is appended so the
 * command actually runs (Enter, as xterm produces onData). Without `execute`,
 * the text is typed at the prompt for the operator to review before pressing
 * Enter — the "safe" review mode for AI-generated commands.
 *
 * The command is always routed to `sessionId` when provided (so the agent acts
 * on the terminal the user is actually looking at); otherwise to the active
 * terminal. Either way it is written via the real PTY/SSH/serial channel, so it
 * appears on screen exactly as if the user had typed it.
 */
export function writeToTerminal(
  cmd: string,
  execute: boolean,
  sessionId?: string | null,
): void {
  const target = resolveTarget(sessionId);
  if (!target || !cmd) return;
  const { sessionId: sid, kind } = target;
  // SFTP tabs have no shell to type into.
  if (kind === "sftp") return;

  const data = execute ? cmd + "\r" : cmd;
  void writerFor(kind)(sid, textToBase64(data));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Write a command block into the terminal LINE BY LINE, so each command appears
 * and runs individually in the live terminal — exactly as if the operator typed
 * and pressed Enter on each line. With `execute=false` the lines are typed for
 * review (no Enter); with `execute=true` each line is terminated with Enter and a
 * short gap is left between lines so a running foreground process is not fed the
 * next command as stdin.
 */
export async function injectCommandLines(
  cmd: string,
  execute: boolean,
  sessionId?: string | null,
): Promise<void> {
  const target = resolveTarget(sessionId);
  if (!target || !cmd) return;
  const { sessionId: sid, kind } = target;
  if (kind === "sftp") return;

  const lines = cmd
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/u, ""))
    .filter((l) => l.length > 0);
  if (lines.length === 0) return;

  const writer = writerFor(kind);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const data = execute ? line + "\r" : line;
    void writer(sid, textToBase64(data));
    // Gap between lines so a still-running foreground process does not consume
    // the next line as its stdin. No delay after the last line.
    if (execute && i < lines.length - 1) await sleep(160);
  }
}

export const EXPLAIN_SYSTEM =
  "You are a senior Linux / embedded ops engineer. The user selected text from their terminal. " +
  "If it is a shell command, explain concisely what it does, its key flags, and any risks " +
  "(e.g. destructive rm, reboot, chmod 777). If it is command output, summarize what it shows. " +
  "Use short bullet points, under 180 words.";

export const FIX_SYSTEM =
  "You are a senior Linux / embedded ops engineer. The user has selected a terminal excerpt that " +
  "shows a problem (an error, a failure, or unexpected behavior). Diagnose the root cause in one " +
  "or two sentences, then give the exact command(s) to fix it as a single fenced bash code block. " +
  "Prefer safe, reversible commands and avoid destructive actions unless they are strictly required. " +
  "Under 200 words.";

export const GENERATE_SYSTEM =
  "You are a Linux / ops command generator. Return ONLY the shell command(s) the user needs, " +
  "as a single fenced bash code block, with no extra prose or explanation. If multiple " +
  "commands are required, put them on separate lines inside the one block. Prefer safe, " +
  "idempotent commands and avoid destructive actions unless explicitly requested.";

/**
 * Explain the currently-selected terminal text. Routes into the inline composer
 * (not the side panel) so the explanation streams back inside the terminal flow.
 */
export function explainSelection(): void {
  const text = useTerminalSelection.getState().text.trim();
  if (!text) return;
  const message = `Explain the following terminal selection:\n\n${text}`;
  useAiComposer.getState().setPrefill(message, true, EXPLAIN_SYSTEM);
}

/** Generate a command from a natural-language request and stream it to the panel. */
export function generateCommand(prompt: string): void {
  const p = prompt.trim();
  if (!p) return;
  const store = useAiStore.getState();
  store.togglePanel(true);
  void store.send(p, {
    title: tFrom(useAppStore.getState().settings.language, "ai.taskGenerateCommand"),
    system: GENERATE_SYSTEM,
  });
}
