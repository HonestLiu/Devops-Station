import { ssh, monitoring } from "@/lib/api";
import { useAiStore } from "./useAiStore";
import { useTerminalSelection } from "./terminalBridge";
import { getTerminalText } from "./terminalBridge";
import { useSerialLog } from "./serialLog";
import { useTabsStore } from "@/store/useTabsStore";
import { buildKbContext, isKbEnabled } from "./knowledgeBase";
import {
  LOG_ANALYSIS_SYSTEM,
  SERIAL_PROTOCOL_SYSTEM,
  SFTP_EXPLAIN_SYSTEM,
  SFTP_DIFF_SYSTEM,
  MONITORING_INSIGHT_SYSTEM,
} from "./prompts";

/** Send a message to the AI panel, optionally augmenting the system prompt with
 *  the local knowledge base (when enabled and loaded). */
function sendWithKb(message: string, system: string, title: string) {
  const kb = isKbEnabled() ? buildKbContext(message) : "";
  const fullSystem = kb ? `${system}\n\n${kb}` : system;
  const store = useAiStore.getState();
  store.togglePanel(true);
  void store.send(message, { title, system: fullSystem });
}

function activeSessionId(): string | null {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  return tab?.sessionId ?? null;
}

/** Analyze arbitrary log/terminal text. */
export function analyzeLog(text: string, title = "Log analysis") {
  const t = text.trim();
  if (!t) return;
  sendWithKb(`Analyze the following output:\n\n${t}`, LOG_ANALYSIS_SYSTEM, title);
}

/** Capture the active terminal (selection, else full screen) and analyze it. */
export function analyzeTerminal() {
  const selection = useTerminalSelection.getState().text.trim();
  const sid = activeSessionId();
  const screen = sid ? getTerminalText(sid) : "";
  const source = selection || screen;
  if (!source) return;
  sendWithKb(
    `Analyze the following terminal output:\n\n${source}`,
    LOG_ANALYSIS_SYSTEM,
    "Log analysis",
  );
}

/** Parse the most recent serial RX data as a protocol. */
export function parseSerialProtocol() {
  const text = useSerialLog.getState().text.trim();
  if (!text) return;
  sendWithKb(
    `Here is recent serial output. Parse it as a protocol:\n\n${text}`,
    SERIAL_PROTOCOL_SYSTEM,
    "Serial protocol",
  );
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** Read a remote file via `cat` and ask the AI to explain it. */
export async function explainFile(sessionId: string, path: string) {
  let content: string;
  try {
    content = await ssh.exec(sessionId, `cat -- ${shellQuote(path)}`);
  } catch (e) {
    sendWithKb(
      `Could not read ${path}: ${String(e)}`,
      SFTP_EXPLAIN_SYSTEM,
      "Explain file",
    );
    return;
  }
  if (!content.trim()) {
    sendWithKb(
      `The file ${path} is empty.`,
      SFTP_EXPLAIN_SYSTEM,
      "Explain file",
    );
    return;
  }
  sendWithKb(
    `File: ${path}\n\n${content}`,
    SFTP_EXPLAIN_SYSTEM,
    "Explain file",
  );
}

/** Read two remote files and ask the AI to diff/explain the changes. */
export async function diffFiles(
  sessionId: string,
  a: string,
  b: string,
) {
  let ca: string;
  let cb: string;
  try {
    ca = await ssh.exec(sessionId, `cat -- ${shellQuote(a)}`);
    cb = await ssh.exec(sessionId, `cat -- ${shellQuote(b)}`);
  } catch (e) {
    sendWithKb(
      `Could not read files for diff: ${String(e)}`,
      SFTP_DIFF_SYSTEM,
      "Diff files",
    );
    return;
  }
  sendWithKb(
    `File A: ${a}\n\n${ca}\n\n=====\n\nFile B: ${b}\n\n${cb}`,
    SFTP_DIFF_SYSTEM,
    "Diff files",
  );
}

/** Sample current host metrics and ask the AI for an insight. */
export async function monitoringInsight(sessionId?: string) {
  let snap: unknown;
  try {
    snap = sessionId ? await monitoring.remote(sessionId) : await monitoring.local();
  } catch (e) {
    sendWithKb(
      `Could not sample metrics: ${String(e)}`,
      MONITORING_INSIGHT_SYSTEM,
      "Monitoring insight",
    );
    return;
  }
  sendWithKb(
    `Current metrics snapshot:\n\n${JSON.stringify(snap, null, 2)}`,
    MONITORING_INSIGHT_SYSTEM,
    "Monitoring insight",
  );
}
