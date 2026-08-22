import { useMemo, useState } from "react";
import { Code2, Fingerprint, FolderClosed, FolderOpen, KeyRound, Network, RotateCw, Sparkles } from "lucide-react";

import { Button } from "@/components/ui";
import { SplitView } from "@/components/terminal/SplitView";
import { SplitControls } from "@/components/terminal/SplitControls";
import { FileBrowserPanel, createSftpAdapter } from "@/components/files/FileBrowserPanel";
import { RemoteFilePreview } from "@/components/sftp/RemoteFilePreview";
import { PortForwardPanel } from "@/components/workspace/PortForwardPanel";
import { KnownHostsDialog } from "@/components/workspace/KnownHostsDialog";
import { SnippetPanel } from "@/components/snippets/SnippetPanel";
import { getTerminalTypeDescription } from "@/ai/terminalAi";
import { explainFile, diffFiles } from "@/ai/tasks";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import type { MenuItem } from "@/store/useContextMenu";
import type { RemoteFile, Tab } from "@/lib/types";

export function SshWorkspace({ tab }: { tab: Tab }) {
  const t = useT();
  const [filesOpen, setFilesOpen] = useState(false);
  const [pfOpen, setPfOpen] = useState(false);
  const [khOpen, setKhOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [preview, setPreview] = useState<RemoteFile | null>(null);
  const reconnect = useTabsStore((s) => s.reconnect);
  const splitPane = useTabsStore((s) => s.splitPane);
  const closePane = useTabsStore((s) => s.closePane);

  const connected = tab.status === "connected" && !!tab.sessionId;
  const paneCount = tab.panes?.length ?? 1;
  const canSplit = !!tab.sshConfig && paneCount < 4;
  const canClosePane = (tab.panes?.length ?? 0) > 1;
  const focusedPaneId = tab.focusedPaneId ?? tab.panes?.[0]?.id;
  // Stable adapter: recreating it per render would re-trigger the panel's
  // load effect and bounce the view back to the home directory.
  const sftpAdapter = useMemo(
    () => (tab.sessionId ? createSftpAdapter(tab.sessionId) : null),
    [tab.sessionId],
  );

  // SFTP-only extras: AI analyze / diff actions on a selected file.
  const sftpAiActions = (f: RemoteFile): MenuItem[] =>
    f.isDir || !tab.sessionId
      ? []
      : [
          {
            id: "ai-explain",
            label: "AI 分析",
            icon: <Sparkles size={14} />,
            onClick: () => void explainFile(tab.sessionId!, f.path),
          },
          {
            id: "ai-diff",
            label: "AI 对比",
            icon: <Sparkles size={14} />,
            onClick: () => {
              const other = window.prompt(
                "Diff against which file? Enter the full remote path:",
                f.path,
              );
              if (other && other.trim()) void diffFiles(tab.sessionId!, f.path, other.trim());
            },
          },
        ];

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
              title={t("ws.screensTitle", { n: paneCount })}
            >
              {t("ws.screens", { n: paneCount })}
            </span>
          )}
          {tab.fingerprint && (
            <span
              className="hidden items-center gap-1 text-[11px] text-subtle sm:flex"
              title={t("ws.fingerprint")}
            >
              <Fingerprint size={12} />
              {tab.fingerprint}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 no-drag">
          <Button
            variant={filesOpen ? "primary" : "ghost"}
            size="sm"
            onClick={() => setFilesOpen((v) => !v)}
            title={t("ws.filesTitle")}
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
            variant={pfOpen ? "primary" : "ghost"}
            size="sm"
            disabled={!connected}
            onClick={() => setPfOpen((v) => !v)}
            title={connected ? t("ws.portForwardTitle") : t("pf.needSession")}
          >
            <Network size={14} />
            {t("ws.portForward")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setKhOpen(true)}
            title={t("ws.knownHostsTitle")}
          >
            <KeyRound size={14} />
            {t("ws.knownHosts")}
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <SplitControls
            paneCount={paneCount}
            canSplit={canSplit}
            canClosePane={canClosePane}
            onSplit={(axis) => void splitPane(tab.id, axis)}
            onClosePane={() => focusedPaneId && void closePane(tab.id, focusedPaneId)}
          />
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title={t("ws.reconnect")}>
            <RotateCw size={14} />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <SplitView tab={tab} />
        </div>

        {filesOpen && connected && tab.sessionId && sftpAdapter && (
          <FileBrowserPanel
            adapter={sftpAdapter}
            sessionId={tab.sessionId}
            onClose={() => {
              setFilesOpen(false);
              setPreview(null);
            }}
            title="SFTP"
            chipIcon={<FolderOpen size={13} />}
            onPreviewFile={(f) => setPreview(f)}
            aiActions={sftpAiActions}
          />
        )}
        {snippetsOpen && (
          <SnippetPanel
            sessionId={tab.sessionId}
            terminalHint={getTerminalTypeDescription(tab.sessionId)}
            onClose={() => setSnippetsOpen(false)}
          />
        )}
        {preview && tab.sessionId && (
          <RemoteFilePreview
            sessionId={tab.sessionId}
            path={preview.path}
            name={preview.name}
            onClose={() => setPreview(null)}
          />
        )}

        {pfOpen && connected && tab.sessionId && (
          <div className="w-[360px] shrink-0 border-l border-border">
            <PortForwardPanel
              sessionId={tab.sessionId}
              hostId={tab.hostId}
              onClose={() => setPfOpen(false)}
            />
          </div>
        )}
      </div>

      <KnownHostsDialog open={khOpen} onClose={() => setKhOpen(false)} />
    </div>
  );
}
