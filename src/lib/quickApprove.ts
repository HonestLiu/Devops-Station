import { ble, pty, serial, ssh } from "@/lib/api";
import { textToBase64 } from "@/lib/utils";
import { useSessionStore } from "@/store/useSessionStore";
import { useTabsStore } from "@/store/useTabsStore";
import { usePermStore } from "@/store/usePermStore";
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

/** How fresh a HOOK-sourced "last approval" target stays eligible. */
const LAST_APPROVAL_TTL_MS = 30_000;

/**
 * The same physical keystroke can reach us twice: once via the OS-level global
 * shortcut (tauri-plugin-global-shortcut) and once via the in-window keydown
 * capture handler. Sending Enter twice to the agent would confirm "Yes" and
 * then immediately trigger something else, so a fire within this window after
 * the previous one is treated as the same keypress.
 */
const DEDUP_MS = 400;
let lastApprovedAt = 0;

/** Whether a session id still maps to a live tab (has a transport to write to). */
function sessionHasTab(sessionId: string): boolean {
  return useTabsStore.getState().tabs.some(
    (t) =>
      t.sessionId === sessionId || !!t.panes?.some((p) => p.sessionId === sessionId),
  );
}

/**
 * Pick the session to approve. Priority:
 *   1. A waiting session inside the *active* tab (text heuristic or HOOK
 *      marker) — the user is looking at it, approve that one.
 *   2. The local session linked to the most recent approval event (≤30s) —
 *      covers agent TUIs whose prompt text never matches the regex, and cases
 *      where the user switched tabs before pressing the shortcut.
 *   3. Any waiting session at all (fall back to the first one flagged).
 *   4. The active tab's session as a last resort — the shortcut is an explicit
 *      user action, so sending Enter to the terminal they are working in is
 *      the least surprising default (an extra Enter at a shell prompt is
 *      harmless; it approves a pending agent menu).
 */
export function findApproveTarget(): string | undefined {
  const { tabs, activeId } = useTabsStore.getState();
  const active = tabs.find((t) => t.id === activeId);
  const inActive = (sid: string) =>
    !!active && (active.sessionId === sid || !!active.panes?.some((p) => p.sessionId === sid));

  // 1. Waiting session in the active tab.
  const waiting = Object.keys(useSessionStore.getState().waitingBySession).filter((sid) =>
    isWaiting(sid),
  );
  const activeWaiting = waiting.find(inActive);
  if (activeWaiting) return activeWaiting;

  // 2. Most recent approval event's linked session (still fresh & alive).
  const last = usePermStore.getState().lastApproval;
  if (last && Date.now() - last.ts < LAST_APPROVAL_TTL_MS && sessionHasTab(last.sessionId)) {
    return last.sessionId;
  }

  // 3. Any waiting session.
  if (waiting.length > 0) return waiting[0];

  // 4. Active tab's session.
  return active?.sessionId || undefined;
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
  // Same keystroke may arrive via both the OS-level and the in-window handler —
  // swallow the duplicate so the agent gets exactly one Enter.
  const now = Date.now();
  if (now - lastApprovedAt < DEDUP_MS) return true;
  lastApprovedAt = now;

  const sid = findApproveTarget();
  if (!sid) return false;
  // Unlike approveSession (bell button — only for sessions actually flagged as
  // waiting), the shortcut may target the active tab as a last resort, so we
  // don't gate on isWaiting here; we only require the session to exist.
  const tab = useTabsStore
    .getState()
    .tabs.find(
      (t) =>
        t.sessionId === sid || !!t.panes?.some((p) => p.sessionId === sid),
    );
  if (!tab) return false;
  await writeEnter(tab, sid);
  return true;
}
