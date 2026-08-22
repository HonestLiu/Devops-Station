import { tFrom } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useAiStore, currentProvider } from "./useAiStore";
import { useAiOrchestrator } from "./useAiOrchestrator";
import { runAgent } from "./agent";
import { AGENT_SYSTEM } from "./prompts";
import {
  getTargetSession,
  getTerminalTypeDescription,
  injectCommandLines,
  extractTool,
} from "./terminalAi";
import { buildAgentContext, buildContext } from "./context";
import { getTerminalLineCount, getTerminalTail } from "./terminalBridge";
import { completeText, streamChat } from "./client";
import type { AgentStep } from "./useAiAgent";
import type { TabKind } from "@/lib/types";

/**
 * Multi-host agent orchestration.
 *
 * The single-host `runAgent` drives one terminal. This module fans a single
 * goal out to several terminal sessions at once (one agent loop per host,
 * running concurrently), then asks the model to synthesize a cross-host
 * comparison. It mirrors Netcatty's "multi-host AI agent" while reusing the
 * existing terminal/streaming plumbing — no new backend calls, just parallel
 * scheduling on top of the same `ai.chat` streaming endpoint.
 */

const MAX_STEPS = 12;
/** Cap how long we wait for a command's output to settle (ms). */
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
 * SSH host-key confirmation prompt, e.g.
 *   Are you sure you want to continue connecting (yes/no/[fingerprint])?
 */
const HOST_KEY_PROMPT = /continue connecting \(yes\/no(?:[^)]*)\)\?/i;

/** Kinds that have no shell to drive — the agent can't run commands on them. */
const EXCLUDED_KINDS = new Set<TabKind>(["sftp", "jlink", "mqtt"]);

export interface HostSessionMeta {
  sessionId: string;
  label: string;
  kind: TabKind;
}

/** Enumerate every terminal session the multi-host agent can target. */
export function listHostSessions(): HostSessionMeta[] {
  const tabs = useTabsStore.getState().tabs;
  const out: HostSessionMeta[] = [];
  for (const tab of tabs) {
    if (EXCLUDED_KINDS.has(tab.kind)) continue;
    if (tab.sessionId) {
      out.push({ sessionId: tab.sessionId, label: tab.title, kind: tab.kind });
    }
    (tab.panes ?? []).forEach((p, i) => {
      if (p.sessionId) {
        out.push({
          sessionId: p.sessionId,
          label: `${tab.title} · pane ${i + 1}`,
          kind: tab.kind,
        });
      }
    });
  }
  return out;
}

/** The model signals the task is complete with a lone `DONE:` line. */
function isDone(text: string): boolean {
  return /^DONE:/m.test(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Wait until a terminal's new output (everything from `startLine`) stops
 * changing, so we capture the command's full result. In `autoRespond` mode it
 * also answers SSH host-key prompts with `yes` (trust-on-first-use), at most
 * once per distinct prompt.
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
        void injectCommandLines("yes", true, sessionId);
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

interface SingleHostResult {
  steps: AgentStep[];
  transcript: string;
  summary: string;
  error: string | null;
}

/**
 * Run the agent loop on a SINGLE host terminal. Returns the captured steps and
 * transcript — it does NOT touch the chat store (progress is reported through
 * `useAiOrchestrator` so the concurrency stays manageable).
 */
async function runSingleHost(
  goal: string,
  sessionId: string,
  autoRun: boolean,
): Promise<SingleHostResult> {
  const appLang = useAppStore.getState().settings.language;
  const langDir =
    appLang === "zh" ? "请始终用中文回答用户。" : "Always respond in English.";
  const typeDesc = getTerminalTypeDescription(sessionId);
  // Same policy as the single-host agent: the first step gets the terminal's
  // recent scrollback attached so the model knows what already ran on this host;
  // later steps use the small env context plus per-command TOOL RESULT deltas.
  const terminalContext = useAppStore.getState().settings.ai.terminalContext;
  const ctx = terminalContext ? buildContext(sessionId) ?? undefined : undefined;
  const ctx0 = terminalContext ? buildAgentContext(sessionId) ?? ctx : undefined;
  const history: Turn[] = [{ role: "user", content: goal }];
  const steps: AgentStep[] = [];
  let transcript = "";
  let summary = "";
  let prevCmd: string | null = null;

  try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const msgs: Turn[] = [
        { role: "system", content: langDir },
        { role: "system", content: AGENT_SYSTEM },
        { role: "system", content: typeDesc },
        ...history,
      ];
      const { text, error } = await completeText({
        provider: currentProvider(),
        messages: msgs,
        context: step === 0 ? ctx0 : ctx,
      });
      if (error) throw new Error(error);
      history.push({ role: "assistant", content: text });

      const cmd = extractTool(text);
      // A model may emit `DONE:` in the SAME turn as its tool call (see
      // `agent.ts`). Only finish when there is no pending command — otherwise
      // the command is dropped and the raw `TOOL:` text leaks into the summary.
      if (!cmd && isDone(text)) {
        summary = text.replace(/^[\s\S]*?\bDONE:\s*/i, "").trim();
        break;
      }
      if (!cmd) {
        const nudge = tFrom(appLang, "ai.agentNeedTool");
        history.push({ role: "user", content: nudge });
        if (step >= 1) break;
        continue;
      }
      if (cmd === prevCmd) {
        const note = tFrom(appLang, "ai.agentRepeatStop");
        steps.push({ cmd, result: note, status: "error" });
        break;
      }
      prevCmd = cmd;

      const target = getTargetSession(sessionId);
      if (!target) {
        const err = tFrom(appLang, "ai.agentNoTerminal");
        steps.push({ cmd, result: err, status: "error" });
        break;
      }

      const startLine = getTerminalLineCount(target);
      await injectCommandLines(cmd, autoRun, target);

      if (!autoRun) {
        const note = tFrom(appLang, "ai.agentTypedForReview");
        steps.push({ cmd, result: note, status: "ok" });
        break;
      }

      await waitForSettle(target, startLine, autoRun);

      const result =
        getTerminalTail(target, startLine) || tFrom(appLang, "ai.agentNoOutput2");
      const resultMsg = `TOOL RESULT:\n${result}`;
      transcript += (transcript ? "\n\n" : "") + resultMsg;
      history.push({ role: "user", content: resultMsg });
      steps.push({ cmd, result, status: result.trim() ? "ok" : "empty" });
    }
    return { steps, transcript, summary, error: null };
  } catch (e) {
    return { steps, transcript, summary, error: String(e) };
  }
}

/** Stream a one-off completion into a chat message; returns the final text. */
async function streamInto(
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
        messages: [{ role: "system", content: langDir }, ...messages],
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

const SYNTH_SYSTEM =
  "You are a senior DevOps orchestrator. The same task was run on multiple hosts via a " +
  "terminal agent. Below are each host's summary and captured output. Write a concise " +
  "synthesis (under 320 words): compare results across hosts, highlight differences and any " +
  "outliers, and flag hosts that failed or diverged. Use the user's language.";

/**
 * Run one goal across multiple hosts in parallel.
 *
 * - Fewer than 2 valid hosts → silently falls back to the single-host
 *   `runAgent` (so the button still "just works" with one host selected).
 * - Creates a dedicated chat session for the cross-host synthesis (visible in
 *   history) and opens the panel.
 * - Drives each host concurrently via `Promise.allSettled`, updating
 *   `useAiOrchestrator` per host so the UI can show live progress.
 */
export async function runAgentMulti(
  goal: string,
  sessionIds: string[],
  autoRun: boolean,
): Promise<void> {
  const appLang = useAppStore.getState().settings.language;
  const all = listHostSessions();
  const byId = new Map(all.map((h) => [h.sessionId, h]));
  const targets = sessionIds
    .map((id) => byId.get(id))
    .filter((h): h is HostSessionMeta => !!h);

  // Fall back to single-host when fewer than 2 hosts are selected.
  if (targets.length < 2) {
    const single = targets[0]?.sessionId ?? all[0]?.sessionId ?? null;
    void runAgent(goal, autoRun, false, single);
    return;
  }

  const store = useAiStore.getState();
  const sid = store.createSession(goal.slice(0, 48) || tFrom(appLang, "ai.multiHost"));
  store.selectSession(sid);
  store.togglePanel(true);

  const orch = useAiOrchestrator.getState();
  orch.reset();
  orch.start(
    goal,
    targets.map((t) => ({ sessionId: t.sessionId, label: t.label, kind: t.kind })),
  );

  const results = await Promise.allSettled(
    targets.map(async (t) => {
      orch.setHostStatus(t.sessionId, "running");
      const r = await runSingleHost(goal, t.sessionId, autoRun);
      for (const s of r.steps) orch.pushStep(t.sessionId, s);
      orch.setHostResult(t.sessionId, {
        finalOutput: r.transcript,
        summary: r.summary,
        error: r.error,
      });
      return r;
    }),
  );

  // Build the cross-host synthesis prompt.
  const sections = targets
    .map((t, i) => {
      const r =
        results[i].status === "fulfilled" ? results[i].value : null;
      const body = r?.transcript ? r.transcript.slice(0, 4000) : "(no output)";
      const sum =
        r?.summary || (r?.error ? `Error: ${r.error}` : "(no summary)");
      return `## ${t.label}\n**Summary:** ${sum}\n\n**Captured output:**\n\`\`\`\n${body}\n\`\`\``;
    })
    .join("\n\n");

  const synthPrompt =
    `Task: ${goal}\n\nHosts (${targets.length}):\n${sections}\n\n` +
    `Now synthesize the cross-host results into a comparison.`;

  void store.addUserMessageTo(sid, `Multi-host task: ${goal}`);
  const aid = store.addAssistantMessageTo(sid);
  const synthesis = await streamInto(
    sid,
    aid,
    [
      { role: "system", content: SYNTH_SYSTEM },
      { role: "user", content: synthPrompt },
    ],
    undefined,
  );

  orch.setSynthesis(synthesis);
  orch.setRunning(false);
}
