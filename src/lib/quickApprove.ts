import { ble, pty, serial, ssh } from "@/lib/api";
import { textToBase64 } from "@/lib/utils";
import { useSessionStore } from "@/store/useSessionStore";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

/**
 * Quick-approval support for vibecoding CLI prompts (Claude Code, Codex, …).
 *
 * Approval UIs are keyboard-driven: the first option ("Yes") is highlighted and
 * Enter confirms it — for Claude Code's "Do you want to proceed?" menu, Codex's
 * "› 1. Yes, proceed (y)" and most other agent CLIs. So "approve" is simply
 * "send Enter to the waiting session". No option indices, no tool-specific
 * logic needed.
 */

/** Whether a session currently looks like it's waiting for approval/input. */
function isWaiting(sessionId: string): boolean {
  return !!useSessionStore.getState().waitingBySession[sessionId];
}

/**
 * Pick the session to approve: prefer one belonging to the *active* tab, falling
 * back to the first waiting session overall.
 */
export function findWaitingSessionId(): string | undefined {
  const waiting = useSessionStore.getState().waitingBySession;
  const sids = Object.keys(waiting).filter((sid) => isWaiting(sid));
  if (sids.length === 0) return undefined;

  const { tabs, activeId } = useTabsStore.getState();
  const active = tabs.find((t) => t.id === activeId);
  const inActive = (sid: string) =>
    !!active && (active.sessionId === sid || !!active.panes?.some((p) => p.sessionId === sid));

  return sids.find(inActive) ?? sids[0];
}

/** Send Enter to the right transport for a session's tab kind. */
function writeEnter(tab: Tab, sessionId: string): Promise<void> {
  const data = textToBase64("\r");
  if (tab.kind === "ssh") return ssh.write(sessionId, data);
  if (tab.kind === "serial") return serial.write(sessionId, data);
  if (tab.kind === "ble") return ble.write(sessionId, data);
  // local / wsl / frp are all PTY-backed.
  return pty.write(sessionId, data);
}

/**
 * Approve the waiting session: find its tab (by sessionId, in the focused pane
 * or the tab itself) and send Enter. Returns false if the session isn't found
 * or isn't waiting.
 */
export async function approveSession(sessionId: string): Promise<boolean> {
  if (!isWaiting(sessionId)) return false;
  const tab = useTabsStore
    .getState()
    .tabs.find(
      (t) =>
        t.sessionId === sessionId || !!t.panes?.some((p) => p.sessionId === sessionId),
    );
  if (!tab) return false;
  await writeEnter(tab, sessionId);
  return true;
}

/** Approve whatever is waiting right now (used by the global shortcut). */
export async function approveWaitingNow(): Promise<boolean> {
  const sid = findWaitingSessionId();
  if (!sid) return false;
  return approveSession(sid);
}
