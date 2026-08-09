import { useTabsStore } from "@/store/useTabsStore";
import { useSessionStore } from "@/store/useSessionStore";

/**
 * Build a short, model-friendly description of the user's current environment so the
 * assistant can answer "why is this server's CPU high?" without the user pasting anything.
 *
 * Returns `null` when there is no active terminal session to describe.
 */
export function buildContext(): string | null {
  const { tabs, activeId } = useTabsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  if (!tab || !tab.sessionId) return null;

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
