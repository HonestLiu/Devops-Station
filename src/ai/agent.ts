import { tFrom } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { buildAgentContext, buildContext } from "./context";
import { getTargetSession, getTerminalTypeDescription, injectCommandLines, writeToTerminal, extractTool } from "./terminalAi";
import { getTerminalLineCount, getTerminalTail } from "./terminalBridge";
import { useAiAgent, type AgentStep } from "./useAiAgent";
import { useAiStore, currentProvider } from "./useAiStore";
import { streamChat } from "./client";
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
 * SSH host-key confirmation prompt and answers `yes` automatically, at most
 * once per distinct host (trust-on-first-use).
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

/** One LLM call in the agent loop. Streams into the transcript, returns text. */
async function complete(
  sid: string,
  msgId: string,
  messages: Turn[],
  context: string | undefined,
): Promise<string> {
  const appLang = useAppStore.getState().settings.language;
  const langDir =
    appLang === "zh" ? "请始终用中文回答用户。" : "Always respond in English.";

  let acc = "";
  await new Promise<void>((resolve) => {
    streamChat(
      {
        provider: currentProvider(),
        messages: [
          { role: "system", content: langDir },
          ...messages,
        ],
        context,
      },
      {
        onDelta: (d) => {
          acc += d;
          useAiStore.getState().appendDelta(sid, msgId, d);
        },
        onDone: (error) => {
          useAiStore.getState().updateMessage(sid, msgId, {
            streaming: false,
            ...(error
              ? { error: true, content: error }
              : { content: acc }),
          });
          resolve();
        },
      },
    );
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
 * `inline=true` keeps the transcript inside the inline composer's agent block
 * (in a transient session that never pollutes the chat history).
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
  // Inline runs keep the agent transcript in a transient session that is NOT
  // made the active chat session and is NOT shown in history — otherwise every
  // agent run would leak a permanent "Agent" session full of raw TOOL RESULT
  // text. The side panel still opens for non-inline runs.
  const sid = inline ? store.createTransientSession() : store.newSession();
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

  try {
    const history: Turn[] = [{ role: "user", content: goal }];
    store.addUserMessageTo(sid, goal);

    // Context is built from the PINNED session so the model sees the terminal
    // the agent actually drives, even if the user switches tabs mid-run.
    // `ctx0` additionally attaches the terminal's recent scrollback so the model
    // knows what a previous task in this shell already did; later steps use only
    // the small env context (fresh cwd) plus the per-command TOOL RESULT deltas.
    const terminalContext = useAppStore.getState().settings.ai.terminalContext;
    const ctx = terminalContext
      ? buildContext(sessionId ?? undefined) ?? undefined
      : undefined;
    const ctx0 = terminalContext
      ? buildAgentContext(sessionId ?? undefined) ?? ctx
      : undefined;

    const typeDesc = getTerminalTypeDescription(sessionId);

    let prevCmd: string | null = null;
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const aid = useAiStore.getState().addAssistantMessageTo(sid);
      const appLang = useAppStore.getState().settings.language;
      const text = await complete(
        sid,
        aid,
        [
          { role: "system", content: AGENT_SYSTEM },
          { role: "system", content: typeDesc },
          ...history,
        ],
        step === 0 ? ctx0 : ctx,
      );
      history.push({ role: "assistant", content: text });

      const cmd = extractTool(text);
      // A model may emit `DONE:` in the SAME turn as its tool call (common for
      // simple tasks where it plans ahead and concludes in one shot). Treat the
      // turn as finished ONLY when there is no pending command — otherwise the
      // command would be dropped un-executed and the raw `TOOL:` text would
      // surface as the "conclusion". Run the command first; the model concludes
      // properly in the following turn once it sees the output.
      if (!cmd && isDone(text)) {
        if (agent) {
          const summary = text.replace(/^[\s\S]*?\bDONE:\s*/i, "").trim();
          agent.setSummary(summary || null);
          agent.setRunning(false);
        }
        break;
      }
      if (!cmd) {
        // The model answered in prose without emitting a tool call. Nudge it
        // once and retry; if it still does not produce a command, stop.
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

      // Snapshot the buffer line count *before* we type, then inject the
      // command(s) LINE BY LINE. We read everything from `startLine` onward so
      // the result includes both the command echo and its actual output.
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
    if (agent) agent.setError(String(e));
    throw e;
  } finally {
    // Reset the running flag on EVERY exit path — including the natural end of
    // the step loop without a DONE. A stuck `running: true` silently blocks
    // auto-diagnose (`maybeAutoDiagnose` early-returns on it).
    if (agent) agent.setRunning(false);
  }
}
