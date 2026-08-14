import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { ai } from "@/lib/api";
import { tFrom } from "@/i18n";
import { useAiStore } from "./useAiStore";
import { useAppStore } from "@/store/useAppStore";
import { buildContext } from "./context";
import { getTargetSession, getTerminalTypeDescription, injectCommandLines, writeToTerminal } from "./terminalAi";
import { getTerminalLineCount, getTerminalTail } from "./terminalBridge";
import { useAiAgent, type AgentStep } from "./useAiAgent";
import { AGENT_SYSTEM } from "./prompts";

const MAX_STEPS = 12;
/** Cap how long the agent waits for a command's output to settle (ms). */
const SETTLE_TIMEOUT_MS = 8000;
/** Poll interval while waiting for the output to stop changing (ms). */
const SETTLE_POLL_MS = 200;
/** Treat output as "settled" once it is unchanged for this many polls. */
const SETTLE_STABLE_POLLS = 2;

type Role = "system" | "user" | "assistant";
interface Turn {
  role: Role;
  content: string;
}

/**
 * Extract a shell command from a model turn. We accept either the explicit
 * `TOOL:bash` marker OR — as a fallback for models that forget the marker — any
 * fenced ```bash block in the reply. This keeps commands flowing into the
 * terminal even when a weaker/local model answers in prose instead of the
 * exact convention, which previously made the agent break out after one turn
 * and "just show an AI answer" without injecting anything.
 */
function extractTool(text: string): string | null {
  const marker = text.search(/TOOL:\s*bash/i);
  if (marker >= 0) {
    const tail = text.slice(marker);
    const fence = tail.match(/```(?:bash)?\s*\n([\s\S]*?)```/);
    if (fence) return fence[1].trim();
    // Fallback: take everything after the marker up to the next blank line.
    const rest = tail
      .replace(/^TOOL:\s*bash\s*/i, "")
      .split(/\n\s*\n/)[0]
      ?.trim();
    return rest || null;
  }
  // No marker: still honor a fenced bash block if the model produced one.
  const fence = text.match(/```(?:bash)?\s*\n([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  return null;
}

function isDone(text: string): boolean {
  return /^DONE:/m.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * SSH host-key confirmation prompt, e.g.
 *   Are you sure you want to continue connecting (yes/no/[fingerprint])?
 * Matched narrowly so we never accidentally auto-answer a generic (yes/no)
 * question such as a git branch-deletion confirmation.
 */
const HOST_KEY_PROMPT = /continue connecting \(yes\/no(?:[^)]*)\)\?/i;

/**
 * Wait until the terminal's new output (everything from `startLine`) stops
 * changing, so we capture the command's full result rather than a partial
 * mid-stream snapshot. Falls back to `SETTLE_TIMEOUT_MS` for commands that keep
 * streaming (builds, pings) or that block on interactive input.
 *
 * When `autoRespond` is set (autonomous run mode), the loop also watches for an
 * SSH host-key confirmation prompt and answers `yes` automatically. Without
 * this, the agent would see the prompt as "stable output", treat it as the
 * command result, and — because it never types `yes` — the SSH client would
 * fail with "Host key verification failed" (and the agent might loop retrying
 * the same command). Only the exact `continue connecting` prompt is answered,
 * and each distinct host is answered at most once (trust-on-first-use, the same
 * a human would do on a first connection).
 */
async function waitForSettle(
  sessionId: string,
  startLine: number,
  autoRespond = false,
): Promise<void> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let last = "";
  let stable = 0;
  const answeredHostKeys = new Set<string>();
  while (Date.now() < deadline) {
    await sleep(SETTLE_POLL_MS);
    const cur = getTerminalTail(sessionId, startLine);

    if (autoRespond) {
      const pending = cur
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => HOST_KEY_PROMPT.test(l))
        .find((l) => !answeredHostKeys.has(l));
      if (pending) {
        answeredHostKeys.add(pending);
        writeToTerminal("yes", true, sessionId);
        stable = 0;
        last = cur;
        await sleep(600);
        continue;
      }
    }

    if (cur === last) {
      stable += 1;
      if (stable >= SETTLE_STABLE_POLLS) return;
    } else {
      stable = 0;
      last = cur;
    }
  }
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
 * Autonomous agent loop.
 *
 * It asks the model for the next `TOOL:bash` command, types it into the *same*
 * terminal the user launched the agent from (so it appears exactly as if they
 * had typed it), optionally presses Enter to run it, captures only the output
 * the command produced, feeds that back, and stops when the model replies
 * `DONE:`.
 *
 * `autoRun=false` (review mode) types the first command but does not run it —
 * control is handed back to the operator, who presses Enter. `autoRun=true`
 * runs every step so the agent can complete a multi-step task on its own.
 *
 * `inline=false` (default) opens the side panel as the display surface;
 * `inline=true` keeps the transcript inside the inline composer's agent block.
 *
 * `sessionId` pins the commands to a specific terminal (e.g. a focused split
 * pane). When omitted, the active terminal is used.
 */
export async function runAgent(
  goal: string,
  autoRun = false,
  inline = false,
  sessionId?: string | null,
): Promise<void> {
  const store = useAiStore.getState();
  // For inline runs we keep the agent transcript in its own session but do NOT
  // make it the active chat session — otherwise the inline "answer" block would
  // later surface the agent's raw monologue, and a follow-up task would appear to
  // vanish behind the stuck agent state. The side panel still opens for non-inline.
  const sid = inline ? store.ensureAgentSession() : store.newSession();
  if (!inline) {
    store.selectSession(sid);
    store.togglePanel(true);
  }

  const agent = inline ? useAiAgent.getState() : null;
  if (agent) {
    agent.reset();
    agent.setGoal(goal);
    agent.setRunning(true);
  }

  const history: Turn[] = [{ role: "user", content: goal }];
  store.addUserMessageTo(sid, goal);

  const ctx = useAppStore.getState().settings.ai.terminalContext
    ? buildContext() ?? undefined
    : undefined;

  // Describe the terminal the agent will drive (OS / shell / serial) so the model
  // adapts its commands to the environment. Pinned to the launch session so it
  // matches the terminal the operator is actually looking at.
  const typeDesc = getTerminalTypeDescription(sessionId);

  try {
    let prevCmd: string | null = null;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const aid = useAiStore.getState().addAssistantMessageTo(sid);
      const appLang = useAppStore.getState().settings.language;
      const text = await complete(
        sid,
        aid,
        [
          {
            role: "system",
            content: appLang === "zh" ? "请始终用中文回答用户。" : "Always respond in English.",
          },
          { role: "system", content: AGENT_SYSTEM },
          { role: "system", content: typeDesc },
          ...history,
        ],
        ctx,
      );
      history.push({ role: "assistant", content: text });

      const cmd = extractTool(text);
      if (isDone(text)) {
        if (agent) {
          const summary = text.replace(/^DONE:/i, "").trim();
          agent.setSummary(summary || null);
          agent.setRunning(false);
        }
        break;
      }
      if (!cmd) {
        // The model answered in prose without emitting a tool call. Nudge it once
        // and retry; if it still does not produce a command, stop. Without this the
        // agent would just break after one turn and look like it "didn't inject
        // anything" — only a text answer appears in the dialog.
        const nudge = tFrom(appLang, "ai.agentNeedTool");
        store.addUserMessageTo(sid, nudge);
        history.push({ role: "user", content: nudge });
        if (step >= 1) {
          if (agent) agent.setRunning(false);
          break;
        }
        continue;
      }

      // Anti-repeat guard: the model must not re-issue the exact same command.
      // Without this, a command whose result was ambiguous would loop forever.
      if (cmd === prevCmd) {
        const note = tFrom(appLang, "ai.agentRepeatStop");
        if (agent) {
          agent.pushStep({ cmd, result: note, status: "error" });
          agent.setRunning(false);
        }
        store.addUserMessageTo(
          sid,
          `TOOL RESULT:\n${tFrom(appLang, "ai.agentRepeatStopDetail")}`,
        );
        break;
      }
      prevCmd = cmd;

      const target = getTargetSession(sessionId);
      if (!target) {
        const err = tFrom(appLang, "ai.agentNoTerminal");
        if (agent) {
          agent.pushStep({ cmd, result: err, status: "error" });
          agent.setRunning(false);
        }
        store.addUserMessageTo(sid, `TOOL RESULT:\n${err}`);
        break;
      }

      // Snapshot the buffer line count *before* we type, then inject the command(s)
      // LINE BY LINE. Each line appears and runs individually in the live terminal.
      // We read everything from `startLine` onward so the result includes both the
      // command echo and its actual output. Sampling after typing would miss output
      // that arrived during the per-line injection delay.
      const startLine = getTerminalLineCount(target);
      await injectCommandLines(cmd, autoRun, target);

      if (!autoRun) {
        const note = tFrom(appLang, "ai.agentTypedForReview");
        if (agent) {
          agent.pushStep({ cmd, result: note, status: "ok" });
          agent.setRunning(false);
        }
        store.addUserMessageTo(
          sid,
          `TOOL RESULT:\n${tFrom(appLang, "ai.agentTypedForReviewDetail")}`,
        );
        break;
      }

      await waitForSettle(target, startLine, autoRun);

      const result =
        getTerminalTail(target, startLine) || tFrom(appLang, "ai.agentNoOutput2");
      const resultMsg = `TOOL RESULT:\n${result}`;
      store.addUserMessageTo(sid, resultMsg);
      history.push({ role: "user", content: resultMsg });

      if (agent) {
        agent.pushStep({ cmd, result, status: result.trim() ? "ok" : "empty" });
      }
    }
  } catch (e) {
    if (agent) {
      agent.setError(String(e));
      agent.setRunning(false);
    }
    throw e;
  }
}
