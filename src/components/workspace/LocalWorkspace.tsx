import { useState } from "react";
import { FolderClosed, FolderOpen, RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { SplitView } from "@/components/terminal/SplitView";
import { SplitControls } from "@/components/terminal/SplitControls";
import { FilesSidebar } from "@/components/FilesSidebar";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

export function LocalWorkspace({ tab }: { tab: Tab }) {
  const reconnect = useTabsStore((s) => s.reconnect);
  const splitPane = useTabsStore((s) => s.splitPane);
  const closePane = useTabsStore((s) => s.closePane);

  const paneCount = tab.panes?.length ?? 1;
  const canSplit = paneCount < 4;
  const canClosePane = (tab.panes?.length ?? 0) > 1;
  const focusedPaneId = tab.focusedPaneId ?? tab.panes?.[0]?.id;
  const [filesOpen, setFilesOpen] = useState(false);
  const connected = tab.status === "connected" && !!tab.sessionId;

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12px] font-medium text-fg">Local Shell</span>
          {paneCount > 1 && (
            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              {paneCount} screens
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 no-drag">
          <Button
            variant={filesOpen ? "primary" : "ghost"}
            size="sm"
            onClick={() => setFilesOpen((v) => !v)}
            title="Toggle local file explorer"
          >
            {filesOpen ? <FolderOpen size={14} /> : <FolderClosed size={14} />}
            Files
          </Button>
          <SplitControls
            paneCount={paneCount}
            canSplit={canSplit}
            canClosePane={canClosePane}
            onSplit={(axis) => void splitPane(tab.id, axis)}
            onClosePane={() => focusedPaneId && void closePane(tab.id, focusedPaneId)}
          />
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title="Restart shell">
            <RotateCw size={14} />
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <SplitView tab={tab} />
        </div>
        {filesOpen && connected && tab.sessionId && (
          <FilesSidebar tab={tab} onClose={() => setFilesOpen(false)} />
        )}
      </div>
    </div>
  );
}
