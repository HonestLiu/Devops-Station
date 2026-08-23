import type { Tab } from "@/lib/types";
import { JLinkFlashWorkspace } from "./jlink/JLinkFlashWorkspace";
import { JLinkGdbWorkspace } from "./jlink/JLinkGdbWorkspace";
import { JLinkRttWorkspace } from "./jlink/JLinkRttWorkspace";

/**
 * A J-Link module tab. The picker page (`JLinkPage`) opens one singleton tab
 * per module (`tab.jlinkModule`), so this component just dispatches to the
 * matching workspace. Bare `kind === "jlink"` tabs (pre-migration leftovers)
 * default to the Flash module.
 *
 * Unlike connection tabs these don't own a session — the probe / GDB / RTT
 * state lives in the backend, so the workspace simply stays mounted and
 * persists across tab switches: navigating away and back never resets it.
 */
export function JLinkWorkspace({ tab }: { tab: Tab }) {
  const mod = tab.jlinkModule ?? "flash";
  return (
    <div className="flex h-full flex-col bg-bg">
      {mod === "rtt" ? (
        <JLinkRttWorkspace />
      ) : mod === "gdb" ? (
        <JLinkGdbWorkspace />
      ) : (
        <JLinkFlashWorkspace />
      )}
    </div>
  );
}
