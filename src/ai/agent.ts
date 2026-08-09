import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { ai } from "@/lib/api";
import { useAiStore } from "./useAiStore";
import { useAppStore } from "@/store/useAppStore";
import { buildContext } from "./context";
import { writeToTerminal } from "./terminalAi";
import { getTerminalText } from "./terminalBridge";
import { useTabsStore } from "@/store/useTabsStore";
import { AGENT_SYSTEM } from "./prompts";

const MAX_STEPS = 8;
const RESULT_WAIT_MS = 1500;

type Role = "system" | "user" | "assistant";
interface Turn {
  role: Role;
  content: string;
}

/** Extract a shell command from a model turn that used the `TOOL:bash` convention. */
function extractTool(text: string): string | null {
  const marker = text.indexOf("TOOL:bash");
  if (marker < 0) return null;
  const tail = text.slice(marker);
  const fence = tail.match(/```(?:bash)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // Fallback: take everything after the marker up to the next blank line.
  const rest = tail
    .replace(/^TOOL:bash\s*/i, "")
    .split(/\n\s*\n/)[0]
    ?.trim();
  return rest || null;
}

function isDone(text: string): boolean {
  return /^DONE:/m.test(text);
}

function activeSessionId(): string | null {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  return tab?.sessionId ?? null;
}

/** Run one AI completion and stream it into the given assistant message. */
async function complete(
  sessionId: string,
  msgId: string,
  messages: Turn[],
  context: string | undefined,
): Promise<string> {
  const settings = useAppStore.getState().settings.ai;
  const provider = {
    kind: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
  };

  const reqId = await ai.chat({ provider, messages, context });

  let acc = "";
  const unChunk: UnlistenFn = await listen<{ id: string; delta: string }>(
    `ai-chunk-${reqId}`,
    (e) => {
      acc += e.payload.delta;
      useAiStore.getState().appendDelta(sessionId, msgId, e.payload.delta);
    },
  );
  await new Promise<void>((resolve) => {
    listen<{ id: string; error: string | null }>(`ai-done-${reqId}`, (e) => {
      unChunk();
      useAiStore.getState().updateMessage(sessionId, msgId, {
        streaming: false,
        error: e.payload.error ? true : undefined,
        content: e.payload.error ?? acc,
      });
      resolve();
    });
  });
  return acc;
}

/**
 * Autonomous agent loop. Opens a dedicated chat, then repeatedly asks the model
 * for the next `TOOL:bash` command, runs it in the active terminal, feeds the
 * output back, and stops when the model replies `DONE:`.
 *
 * `autoRun=false` (default) types the command for the operator to review before
 * pressing Enter; `autoRun=true` executes immediately.
 */
export async function runAgent(goal: string, autoRun = false): Promise<void> {
  const store = useAiStore.getState();
  store.togglePanel(true);
  const sid = store.newSession();
  store.selectSession(sid);

  const history: Turn[] = [{ role: "user", content: goal }];
  store.addUserMessage(goal);

  const ctx = useAppStore.getState().settings.ai.terminalContext
    ? buildContext() ?? undefined
    : undefined;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const aid = useAiStore.getState().addAssistantMessage();
    const text = await complete(
      sid,
      aid,
      [{ role: "system", content: AGENT_SYSTEM }, ...history],
      ctx,
    );
    history.push({ role: "assistant", content: text });

    const cmd = extractTool(text);
    if (!cmd || isDone(text)) break;

    // Execute (or type) the proposed command in the active terminal.
    writeToTerminal(cmd, autoRun);
    await new Promise((r) => setTimeout(r, RESULT_WAIT_MS));

    let result = "(no terminal output captured)";
    const sid2 = activeSessionId();
    if (sid2) {
      const screen = getTerminalText(sid2);
      result = screen.length > 4000 ? screen.slice(-4000) : screen;
    }
    const resultMsg = `TOOL RESULT:\n${result}`;
    useAiStore.getState().addUserMessage(resultMsg);
    history.push({ role: "user", content: resultMsg });
  }
}
