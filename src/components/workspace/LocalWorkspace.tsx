import { useMemo, useState } from "react";
import { Code2, FolderClosed, FolderOpen, GitBranch, RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { SplitView } from "@/components/terminal/SplitView";
import { SplitControls } from "@/components/terminal/SplitControls";
import { FileBrowserPanel, createLocalAdapter } from "@/components/files/FileBrowserPanel";
import { GitPanel } from "@/components/git/GitPanel";
import { SnippetPanel } from "@/components/snippets/SnippetPanel";
import { getTerminalTypeDescription } from "@/ai/terminalAi";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import { useSessionStore } from "@/store/useSessionStore";
import type { Tab } from "@/lib/types";

export function LocalWorkspace({ tab }: { tab: Tab }) {
  const t = useT();
  const reconnect = useTabsStore((s) => s.reconnect);
  const splitPane = useTabsStore((s) => s.splitPane);
  const closePane = useTabsStore((s) => s.closePane);

  const paneCount = tab.panes?.length ?? 1;
  const canSplit = paneCount < 4;
  const canClosePane = (tab.panes?.length ?? 0) > 1;
  const focusedPaneId = tab.focusedPaneId ?? tab.panes?.[0]?.id;
  const [filesOpen, setFilesOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const connected = tab.status === "connected" && !!tab.sessionId;
  const cwd = useSessionStore((s) => (tab.sessionId ? s.cwdBySession[tab.sessionId] : undefined));
  // Stable adapter: recreating it per render would re-trigger the panel's
  // load effect and bounce the view back to the home directory.
  const localAdapter = useMemo(() => createLocalAdapter(tab), [tab]);

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12px] font-medium text-fg">{t("ws.localShell")}</span>
          {paneCount > 1 && (
            <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
              {t("ws.screens", { n: paneCount })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 no-drag">
          <Button
            variant={filesOpen ? "primary" : "ghost"}
            size="sm"
            onClick={() => setFilesOpen((v) => !v)}
            title={t("ws.filesLocalTitle")}
          >
            {filesOpen ? <FolderOpen size={14} /> : <FolderClosed size={14} />}
            {t("ws.files")}
          </Button>
          <Button
            variant={snippetsOpen ? "primary" : "ghost"}
            size="sm"
            onClick={() => setSnippetsOpen((v) => !v)}
            title={t("ws.snippetsTitle")}
          >
            <Code2 size={14} />
            {t("ws.snippets")}
          </Button>
          <Button
            variant={gitOpen ? "primary" : "ghost"}
            size="sm"
            onClick={() => setGitOpen((v) => !v)}
            title={t("git.title")}
          >
            <GitBranch size={14} />
            {t("git.title")}
          </Button>
          <SplitControls
            paneCount={paneCount}
            canSplit={canSplit}
            canClosePane={canClosePane}
            onSplit={(axis) => void splitPane(tab.id, axis)}
            onClosePane={() => focusedPaneId && void closePane(tab.id, focusedPaneId)}
          />
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title={t("ws.restartShell")}>
            <RotateCw size={14} />
          </Button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <SplitView tab={tab} />
        </div>
        {filesOpen && connected && tab.sessionId && (
          <FileBrowserPanel
            adapter={localAdapter}
            sessionId={tab.sessionId}
            onClose={() => setFilesOpen(false)}
            title="Files"
            chipIcon={<FolderOpen size={13} />}
          />
        )}
        {gitOpen && connected && tab.sessionId && cwd && (
          <GitPanel cwd={cwd} onClose={() => setGitOpen(false)} />
        )}
        {snippetsOpen && (
          <SnippetPanel
            sessionId={tab.sessionId}
            terminalHint={getTerminalTypeDescription(tab.sessionId)}
            onClose={() => setSnippetsOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
