import { useTabsStore } from "@/store/useTabsStore";
import { useSessionStore } from "@/store/useSessionStore";
import { getTerminalText } from "./terminalBridge";
import type { Tab } from "@/lib/types";

/** Cap on scrollback lines attached to the agent's starting context. */
const AGENT_SCROLLBACK_LINES = 120;
/** Cap the length of a single attached line so one huge line can't blow the prompt. */
const AGENT_MAX_LINE_LEN = 240;

/**
 * Resolve the tab (and its terminal session id) that owns `sessionOrTabId`.
 *
 * The agent pins a *terminal session id* (`tab.sessionId` / pane `sessionId`),
 * which is distinct from the tab's own `id` (`tab-N`). The old code matched
 * `tab.id === sessionId`, so a pinned (inline) agent never resolved a tab and
 * got NO context. Match by session id first, then fall back to tab id (the
 * global `activeId`), so both the pinned and unpinned cases work.
 */
function resolveSession(
  sessionOrTabId?: string,
): { tab: Tab; sessionId: string } | null {
  const { tabs, activeId } = useTabsStore.getState();
  const id = sessionOrTabId ?? activeId;
  if (!id) return null;
  for (const tab of tabs) {
    if (tab.sessionId === id) return { tab, sessionId: tab.sessionId };
    const pane = tab.panes?.find((p) => p.sessionId === id);
    if (pane?.sessionId) return { tab, sessionId: pane.sessionId };
  }
  const tab = tabs.find((t) => t.id === id);
  if (tab?.sessionId) return { tab, sessionId: tab.sessionId };
  return null;
}

/**
 * Build a short, model-friendly description of the user's current environment so the
 * assistant can answer "why is this server's CPU high?" without the user pasting anything.
 *
 * When `sessionId` is given (e.g. the terminal an agent run is pinned to), that
 * session's tab is described instead of the global active tab — otherwise an
 * agent driving one terminal while the user switched tabs would get context
 * about the *wrong* host.
 *
 * Returns `null` when there is no describable terminal session.
 */
export function buildContext(sessionId?: string): string | null {
  const resolved = resolveSession(sessionId);
  if (!resolved) return null;
  const { tab, sessionId: sid } = resolved;

  // Prefer the live OSC-7 cwd for the session; fall back to the spawn-time cwd.
  const cwd = useSessionStore.getState().cwdBySession[sid] ?? tab.cwd;
  const lines: string[] = [];
  lines.push(`Connection type: ${tab.kind.toUpperCase()}`);
  if (tab.subtitle) lines.push(`Target: ${tab.subtitle}`);
  if (cwd) lines.push(`Current directory: ${cwd}`);

  if (
    tab.kind === "ssh" ||
    tab.kind === "wsl" ||
    tab.kind === "frp" ||
    tab.kind === "sftp"
  ) {
    lines.push(
      "The user is a Linux / embedded operator. Prefer concise, copy-pasteable commands " +
        "and call out risks (e.g. destructive rm, reboot) before suggesting them.",
    );
  }
  return lines.length > 1 ? lines.join("\n") : null;
}

/**
 * Agent-start context: the environment description PLUS the terminal's recent
 * scrollback, so the model "sees" the shell the way the operator does — it can
 * tell what a PREVIOUS task already ran and produced (an agent run otherwise
 * starts from a blank slate and has no memory of earlier runs in the same
 * terminal).
 *
 * Used only for the FIRST step of an agent run. Subsequent steps get just
 * `buildContext` (fresh live cwd) plus the per-command `TOOL RESULT` deltas, so
 * we never re-feed the same scrollback every step (that used to make the model
 * re-issue already-run commands).
 */
export function buildAgentContext(sessionId?: string): string | null {
  const base = buildContext(sessionId);
  const resolved = resolveSession(sessionId);
  if (!resolved) return base;
  const scrollback = getTerminalText(resolved.sessionId, AGENT_SCROLLBACK_LINES)
    .split("\n")
    .map((l) =>
      l.length > AGENT_MAX_LINE_LEN
        ? l.slice(0, AGENT_MAX_LINE_LEN) + "…"
        : l,
    )
    .join("\n");
  if (!scrollback) return base;
  const head =
    "TERMINAL STATE (output already visible in the shell — reference only; " +
    "do NOT re-run commands shown here unless the task needs them):";
  return base
    ? `${base}\n\n${head}\n${scrollback}`
    : `${head}\n${scrollback}`;
}
