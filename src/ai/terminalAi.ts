import { ssh, pty, serial } from "@/lib/api";
import { dataLink } from "@/lib/dataLink";
import { textToBase64 } from "@/lib/utils";
import { tFrom } from "@/i18n";
import { isMac, isWindows } from "@/lib/platform";
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
      // The local shell runs on the SAME machine as this app, so the real OS is
      // the app's own platform — don't infer it from the shell path. An empty or
      // exotic `tab.shell` used to make the old `!tab.shell` test report Windows,
      // which sent the agent down the wrong (Windows) command path on macOS.
      const os = isMac ? "macOS" : isWindows ? "Windows" : "Linux";
      parts.push(
        `TERMINAL ENVIRONMENT: a LOCAL ${os} shell (${fam}). ` +
          (isWindows
            ? "Prefer PowerShell/cmd syntax as appropriate; be careful with Windows path quoting and backslashes."
            : os === "macOS"
              ? "Use Unix/macOS command syntax and forward slashes for paths. Homebrew is usually at /opt/homebrew/bin (Apple Silicon) or /usr/local/bin (Intel); if `brew` is not found, the shell did not load the login profile."
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
 * Write raw bytes into a terminal (used by hex-mode Quick Commands that send
 * device / serial protocols). `bytes` are base64-encoded the same way the
 * text path does, so the backend decodes them back to the exact octets.
 */
export function writeRawBytes(bytes: Uint8Array, sessionId?: string | null): void {
  const target = resolveTarget(sessionId);
  if (!target || bytes.length === 0) return;
  const { sessionId: sid, kind } = target;
  if (kind === "sftp") return;
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  void writerFor(kind)(sid, btoa(bin));
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

  const rawLines = cmd
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/u, ""));

  // Merge lines that end with a backslash continuation (`\` + newline).
  // The shell treats `<line>\` + newline as a single logical command, so we
  // must deliver it in one write rather than splitting on newlines.
  const lines: string[] = [];
  let pending = "";
  for (const raw of rawLines) {
    if (pending !== "") {
      // continuation – join with previous line (strip leading whitespace)
      pending += " " + raw.replace(/^\s+/, "");
    } else {
      pending = raw;
    }
    if (pending.endsWith("\\") && pending.length > 0) {
      // Strip the trailing backslash and keep accumulating.
      pending = pending.slice(0, -1);
    } else {
      if (pending.length > 0) lines.push(pending);
      pending = "";
    }
  }
  // Flush any leftover continuation-only tail.
  if (pending.length > 0) lines.push(pending);
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

/**
 * Tool markers the agent accepts. `TOOL:bash` is the canonical marker the prompt
 * asks for, but on a Windows/PowerShell terminal a model may (reasonably) reach
 * for `TOOL:powershell` / `TOOL:ps` / `TOOL:cmd` instead — every one is accepted
 * so an agent run never silently degrades to "just text" on PowerShell.
 */
const TOOL_MARKER = /TOOL:\s*(?:bash|powershell|pwsh|ps|cmd|shell|sh)\s*/i;

/** A standalone ``` / ```lang fence line, or a bare `TOOL:xxx` marker line. */
function isMetaLine(line: string): boolean {
  const l = line.trim();
  if (/^`{3,}\w*$/.test(l)) return true;
  return /^TOOL:\s*(?:bash|powershell|pwsh|ps|cmd|shell|sh)\s*$/i.test(l);
}

/**
 * Strip stray fence / `TOOL:` / blank lines that could slip past the primary
 * extraction (the defensive net for a partially-malformed block). Real content
 * lines keep their indentation so multi-line PowerShell blocks still parse.
 */
function cleanCommand(cmd: string): string | null {
  const kept = cmd
    .split("\n")
    .filter((raw) => raw.trim() !== "" && !isMetaLine(raw));
  const out = kept.join("\n").trim();
  return out || null;
}

/**
 * Extract a shell command from a model turn.
 *
 * Accepts the explicit `TOOL:` marker (any shell family) OR — as a fallback for
 * models that forget the marker — any fenced code block whatever its language
 * label (`bash`, `powershell`, `ps`, `cmd`, `sh`, …). Previously only
 * `TOOL:bash` and ```bash fences were honored: on a PowerShell terminal a model
 * labels its block ```powershell (or writes TOOL:powershell / TOOL:cmd), the
 * command was rejected, and the agent answered in prose forever — "only outputs
 * text". This keeps commands flowing into the terminal on every shell.
 */
export function extractTool(text: string): string | null {
  const marker = text.search(TOOL_MARKER);
  if (marker >= 0) {
    const tail = text.slice(marker);
    const fence = tail.match(/```[^\n`]*\s*\n([\s\S]*?)```/);
    if (fence) return cleanCommand(fence[1]);
    // Fallback: everything after the marker up to the next blank line.
    const rest = tail.replace(TOOL_MARKER, "").split(/\n\s*\n/)[0]?.trim();
    return cleanCommand(rest ?? "");
  }
  // No marker: still honor a fenced block if the model produced one.
  const fence = text.match(/```[^\n`]*\s*\n([\s\S]*?)```/);
  if (fence) return cleanCommand(fence[1]);
  return null;
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
 * System prompt for the free-form "ask a question about the selection" action.
 * The user has box-selected terminal text and is asking their own question; the
 * selection is attached as context. Answer concisely, grounded in that context.
 */
export const ASK_SYSTEM =
  "You are a senior Linux / embedded / DevOps engineer helping the user understand their " +
  "terminal. The user has selected text from their terminal and is asking a question about it. " +
  "Answer concisely and directly using the selected terminal text as the primary context. " +
  "When a command or fix is warranted, put it in a single fenced bash code block. " +
  "Be precise; if the selection is ambiguous, say what you can and what is missing. Under 250 words.";

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
