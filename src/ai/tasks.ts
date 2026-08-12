import { ssh, monitoring } from "@/lib/api";
import { tFrom, type TKey } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { useAiStore } from "./useAiStore";
import { useAiComposer } from "./useAiComposer";
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

/**
 * Dispatch a message to the AI. When `inline` is false (legacy), it opens the
 * side panel and sends. When `inline` is true, it routes through the inline
 * composer so the answer streams back inside the terminal instead of popping a
 * separate chat panel.
 */
function dispatch(message: string, system: string, title: string, inline: boolean) {
  const kb = isKbEnabled() ? buildKbContext(message) : "";
  const fullSystem = kb ? `${system}\n\n${kb}` : system;
  if (inline) {
    useAiComposer.getState().setPrefill(message, true, fullSystem);
  } else {
    const store = useAiStore.getState();
    store.togglePanel(true);
    void store.send(message, { title, system: fullSystem });
  }
}

function activeSessionId(): string | null {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  return tab?.sessionId ?? null;
}

/** Session-title helper (non-React path). */
function sessionTitle(key: TKey): string {
  return tFrom(useAppStore.getState().settings.language, key);
}

/** Analyze arbitrary log/terminal text. */
export function analyzeLog(text: string, title = sessionTitle("ai.taskLogAnalysis")) {
  const t = text.trim();
  if (!t) return;
  dispatch(`Analyze the following output:\n\n${t}`, LOG_ANALYSIS_SYSTEM, title, false);
}

/** Capture the active terminal (selection, else full screen) and analyze it. */
export function analyzeTerminal(inline = false) {
  const selection = useTerminalSelection.getState().text.trim();
  const sid = activeSessionId();
  const screen = sid ? getTerminalText(sid) : "";
  const source = selection || screen;
  if (!source) return;
  dispatch(
    `Analyze the following terminal output:\n\n${source}`,
    LOG_ANALYSIS_SYSTEM,
    sessionTitle("ai.taskLogAnalysis"),
    inline,
  );
}

/** Parse the most recent serial RX data as a protocol. */
export function parseSerialProtocol(inline = false) {
  const text = useSerialLog.getState().text.trim();
  if (!text) return;
  dispatch(
    `Here is recent serial output. Parse it as a protocol:\n\n${text}`,
    SERIAL_PROTOCOL_SYSTEM,
    sessionTitle("ai.taskSerialProtocol"),
    inline,
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
    dispatch(
      `Could not read ${path}: ${String(e)}`,
      SFTP_EXPLAIN_SYSTEM,
      sessionTitle("ai.taskExplainFile"),
      false,
    );
    return;
  }
  if (!content.trim()) {
    dispatch(
      `The file ${path} is empty.`,
      SFTP_EXPLAIN_SYSTEM,
      sessionTitle("ai.taskExplainFile"),
      false,
    );
    return;
  }
  dispatch(
    `File: ${path}\n\n${content}`,
    SFTP_EXPLAIN_SYSTEM,
    sessionTitle("ai.taskExplainFile"),
    false,
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
    dispatch(
      `Could not read files for diff: ${String(e)}`,
      SFTP_DIFF_SYSTEM,
      sessionTitle("ai.taskDiffFiles"),
      false,
    );
    return;
  }
  dispatch(
    `File A: ${a}\n\n${ca}\n\n=====\n\nFile B: ${b}\n\n${cb}`,
    SFTP_DIFF_SYSTEM,
    sessionTitle("ai.taskDiffFiles"),
    false,
  );
}

/** Sample current host metrics and ask the AI for an insight. */
export async function monitoringInsight(sessionId?: string, inline = false) {
  let snap: unknown;
  try {
    snap = sessionId ? await monitoring.remote(sessionId) : await monitoring.local();
  } catch (e) {
    dispatch(
      `Could not sample metrics: ${String(e)}`,
      MONITORING_INSIGHT_SYSTEM,
      sessionTitle("ai.taskMonitoringInsight"),
      inline,
    );
    return;
  }
  dispatch(
    `Current metrics snapshot:\n\n${JSON.stringify(snap, null, 2)}`,
    MONITORING_INSIGHT_SYSTEM,
    sessionTitle("ai.taskMonitoringInsight"),
    inline,
  );
}
