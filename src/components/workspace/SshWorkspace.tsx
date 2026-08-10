import { useState } from "react";
import { Fingerprint, FolderClosed, FolderOpen, RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { TerminalAiButton } from "@/ai/TerminalAiButton";
import { SplitView } from "@/components/terminal/SplitView";
import { SplitControls } from "@/components/terminal/SplitControls";
import { SftpPanel } from "@/components/sftp/SftpPanel";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

export function SshWorkspace({ tab }: { tab: Tab }) {
  const [sftpOpen, setSftpOpen] = useState(false);
  const reconnect = useTabsStore((s) => s.reconnect);
  const patch = useTabsStore((s) => s.patch);
  const splitPane = useTabsStore((s) => s.splitPane);
  const closePane = useTabsStore((s) => s.closePane);

  const connected = tab.status === "connected" && !!tab.sessionId;
  const paneCount = tab.panes?.length ?? 1;
  const canSplit = !!tab.sshConfig && paneCount < 4;
  const canClosePane = (tab.panes?.length ?? 0) > 1;
  const focusedPaneId = tab.focusedPaneId ?? tab.panes?.[0]?.id;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          <span className="truncate font-medium text-fg">{tab.title}</span>
          <span className="truncate text-subtle">{tab.subtitle}</span>
          {paneCount > 1 && (
            <span
              className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent"
              title={`${paneCount} split panes (max 4)`}
            >
              {paneCount} screens
            </span>
          )}
          {tab.fingerprint && (
            <span
              className="hidden items-center gap-1 text-[11px] text-subtle sm:flex"
              title="Server host key fingerprint (SHA-256)"
            >
              <Fingerprint size={12} />
              {tab.fingerprint}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 no-drag">
          <Button
            variant={sftpOpen ? "primary" : "ghost"}
            size="sm"
            onClick={() => setSftpOpen((v) => !v)}
            title="Toggle SFTP file manager"
          >
            {sftpOpen ? <FolderOpen size={14} /> : <FolderClosed size={14} />}
            SFTP
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <SplitControls
            paneCount={paneCount}
            canSplit={canSplit}
            canClosePane={canClosePane}
            onSplit={(axis) => void splitPane(tab.id, axis)}
            onClosePane={() => focusedPaneId && void closePane(tab.id, focusedPaneId)}
          />
          <TerminalAiButton tab={tab} />
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title="Reconnect">
            <RotateCw size={14} />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <SplitView tab={tab} />
        </div>

        {sftpOpen && connected && tab.sessionId && (
          <SftpPanel sessionId={tab.sessionId} onClose={() => setSftpOpen(false)} />
        )}
      </div>
    </div>
  );
}
