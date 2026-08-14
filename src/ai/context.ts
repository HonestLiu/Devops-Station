import { useTabsStore } from "@/store/useTabsStore";
import { useSessionStore } from "@/store/useSessionStore";

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
  const { tabs, activeId } = useTabsStore.getState();
  const targetId = sessionId ?? activeId;
  const tab = tabs.find((t) => t.id === targetId);
  if (!tab || !tab.sessionId) return null;

  // Prefer the live OSC-7 cwd for the session; fall back to the spawn-time cwd.
  const cwd =
    useSessionStore.getState().cwdBySession[tab.sessionId] ?? tab.cwd;
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
