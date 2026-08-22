import { useMemo, useState } from "react";
import { Code2, FolderClosed, FolderOpen, RotateCw, Usb } from "lucide-react";

import { Button } from "@/components/ui";
import { SplitView } from "@/components/terminal/SplitView";
import { SplitControls } from "@/components/terminal/SplitControls";
import { FileBrowserPanel, createWslAdapter } from "@/components/files/FileBrowserPanel";
import { WSLUSBPanel } from "@/components/wsl/WSLUSBPanel";
import { SnippetPanel } from "@/components/snippets/SnippetPanel";
import { getTerminalTypeDescription } from "@/ai/terminalAi";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

/**
 * A WSL session *is* a local PTY session — `wsl.exe` is spawned on the ConPTY
 * slave, so the Terminal component talks to it over the exact same `pty-*`
 * events as the local shell. Only the spawn side differs (handled in the
 * store / backend).
 */
export function WslWorkspace({ tab }: { tab: Tab }) {
  const t = useT();
  const [filesOpen, setFilesOpen] = useState(false);
  const [usbOpen, setUsbOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const reconnect = useTabsStore((s) => s.reconnect);
  const splitPane = useTabsStore((s) => s.splitPane);
  const closePane = useTabsStore((s) => s.closePane);

  const connected = tab.status === "connected" && !!tab.sessionId;
  const paneCount = tab.panes?.length ?? 1;
  const canSplit = paneCount < 4;
  const canClosePane = (tab.panes?.length ?? 0) > 1;
  const focusedPaneId = tab.focusedPaneId ?? tab.panes?.[0]?.id;
  // Stable adapter (recreating it per render would bounce the panel home).
  const wslAdapter = useMemo(() => createWslAdapter(tab.wsl?.distro), [tab.wsl?.distro]);

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12px] font-medium text-fg">{tab.title || "WSL"}</span>
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
            variant={usbOpen ? "primary" : "ghost"}
            size="sm"
            onClick={() => setUsbOpen((v) => !v)}
            title={t("ws.usbTitle")}
          >
            <Usb size={14} />
            {t("ws.usb")}
          </Button>
          <SplitControls
            paneCount={paneCount}
            canSplit={canSplit}
            canClosePane={canClosePane}
            onSplit={(axis) => void splitPane(tab.id, axis)}
            onClosePane={() => focusedPaneId && void closePane(tab.id, focusedPaneId)}
          />
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title={t("ws.restartSession")}>
            <RotateCw size={14} />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <SplitView tab={tab} />
        </div>

        {filesOpen && connected && tab.sessionId && (
          <FileBrowserPanel
            adapter={wslAdapter}
            sessionId={tab.sessionId}
            onClose={() => setFilesOpen(false)}
            title="WSL"
            chipIcon={<FolderOpen size={13} />}
          />
        )}

        {snippetsOpen && (
          <SnippetPanel
            sessionId={tab.sessionId}
            terminalHint={getTerminalTypeDescription(tab.sessionId)}
            onClose={() => setSnippetsOpen(false)}
          />
        )}

        {usbOpen && (
          <WSLUSBPanel
            distro={tab.wsl?.distro ?? ""}
            connected={connected}
            onClose={() => setUsbOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
