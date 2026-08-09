import { useState } from "react";
import { FolderClosed, FolderOpen, RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { ConnectionOverlay } from "@/components/ConnectionOverlay";
import { Terminal } from "@/components/terminal/Terminal";
import { WslPanel } from "@/components/sftp/WslPanel";
import { TerminalAiButton } from "@/ai/TerminalAiButton";
import { useTerminalTheme } from "@/hooks/useTerminalTheme";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

/**
 * A WSL session *is* a local PTY session — `wsl.exe` is spawned on the ConPTY
 * slave, so the Terminal component talks to it over the exact same `pty-*`
 * events as the local shell. Only the spawn side differs (handled in the
 * store / backend). We reuse the LocalWorkspace layout verbatim.
 */
export function WslWorkspace({ tab }: { tab: Tab }) {
  const [wslOpen, setWslOpen] = useState(false);
  const t = useTerminalTheme();
  const reconnect = useTabsStore((s) => s.reconnect);
  const patch = useTabsStore((s) => s.patch);

  const connected = tab.status === "connected" && !!tab.sessionId;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <span className="truncate text-[12px] font-medium text-fg">{tab.title || "WSL"}</span>
        <div className="flex items-center gap-1.5 no-drag">
          <Button
            variant={wslOpen ? "primary" : "ghost"}
            size="sm"
            onClick={() => setWslOpen((v) => !v)}
            title="Toggle WSL file manager"
          >
            {wslOpen ? <FolderOpen size={14} /> : <FolderClosed size={14} />}
            Files
          </Button>
          <TerminalAiButton tab={tab} />
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title="Restart session">
            <RotateCw size={14} />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {connected && tab.sessionId && (
            <Terminal
              key={tab.sessionId}
              sessionId={tab.sessionId}
              transport="pty"
              trackCwd
              theme={t.theme}
              fontFamily={t.fontFamily}
              fontSize={t.fontSize}
              lineHeight={t.lineHeight}
              cursorBlink={t.cursorBlink}
              cursorStyle={t.cursorStyle}
              scrollback={t.scrollback}
              onClosed={(info) => patch(tab.id, { status: "closed", error: info.reason })}
            />
          )}
          {tab.status !== "connected" && <ConnectionOverlay tab={tab} />}
        </div>

        {wslOpen && connected && tab.sessionId && (
          <WslPanel
            sessionId={tab.sessionId}
            distro={tab.wsl?.distro}
            onClose={() => setWslOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
