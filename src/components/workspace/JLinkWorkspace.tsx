import { JLinkPage } from "@/pages/JLinkPage";
import type { Tab } from "@/lib/types";

/**
 * A J-Link tool tab. Unlike connection tabs it doesn't own a session — the
 * probe / GDB-server state lives in the backend, so the tab simply keeps the
 * J-Link panel mounted and persists across tab switches: navigating away and
 * back no longer resets it.
 */
export function JLinkWorkspace({ tab }: { tab: Tab }) {
  return (
    <div className="flex h-full flex-col bg-bg">
      <JLinkPage />
    </div>
  );
}
