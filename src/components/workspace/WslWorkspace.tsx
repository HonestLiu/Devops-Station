import { useMemo, useState } from "react";
import { Code2, Container, FolderClosed, FolderOpen, GitBranch, RotateCw, Usb } from "lucide-react";

import { Button } from "@/components/ui";
import { SplitView } from "@/components/terminal/SplitView";
import { FileBrowserPanel, createWslAdapter } from "@/components/files/FileBrowserPanel";
import { WSLUSBPanel } from "@/components/wsl/WSLUSBPanel";
import { GitPanel } from "@/components/git/GitPanel";
import { DockerPanel } from "@/components/docker/DockerPanel";
import { SnippetPanel } from "@/components/snippets/SnippetPanel";
import { getTerminalTypeDescription } from "@/ai/terminalAi";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import { useSessionStore } from "@/store/useSessionStore";
import { useAppStore } from "@/store/useAppStore";
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
  const [gitOpen, setGitOpen] = useState(false);
  const [dockerOpen, setDockerOpen] = useState(false);
  const reconnect = useTabsStore((s) => s.reconnect);
  const features = useAppStore((s) => s.settings.features);

  const connected = tab.status === "connected" && !!tab.sessionId;
  const cwd = useSessionStore((s) => (tab.sessionId ? s.cwdBySession[tab.sessionId] : undefined));
  const paneCount = tab.panes?.length ?? 1;
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
          {features.files && (
            <Button
              variant={filesOpen ? "primary" : "ghost"}
              size="sm"
              onClick={() => setFilesOpen((v) => !v)}
              title={t("ws.filesTitle")}
            >
              {filesOpen ? <FolderOpen size={14} /> : <FolderClosed size={14} />}
              {t("ws.files")}
            </Button>
          )}
          {features.snippets && (
            <Button
              variant={snippetsOpen ? "primary" : "ghost"}
              size="sm"
              onClick={() => setSnippetsOpen((v) => !v)}
              title={t("ws.snippetsTitle")}
            >
              <Code2 size={14} />
              {t("ws.snippets")}
            </Button>
          )}
          {features.usb && (
            <Button
              variant={usbOpen ? "primary" : "ghost"}
              size="sm"
              onClick={() => setUsbOpen((v) => !v)}
              title={t("ws.usbTitle")}
            >
              <Usb size={14} />
              {t("ws.usb")}
            </Button>
          )}
          {features.git && (
            <Button
              variant={gitOpen ? "primary" : "ghost"}
              size="sm"
              onClick={() => setGitOpen((v) => !v)}
              title={t("git.title")}
            >
              <GitBranch size={14} />
              {t("git.title")}
            </Button>
          )}
          {features.docker && (
            <Button
              variant={dockerOpen ? "primary" : "ghost"}
              size="sm"
              disabled={!connected}
              onClick={() => setDockerOpen((v) => !v)}
              title={connected ? t("docker.title") : t("pf.needSession")}
            >
              <Container size={14} />
              {t("docker.title")}
            </Button>
          )}
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

        {features.files && filesOpen && connected && tab.sessionId && (
          <FileBrowserPanel
            adapter={wslAdapter}
            sessionId={tab.sessionId}
            onClose={() => setFilesOpen(false)}
            title="WSL"
            chipIcon={<FolderOpen size={13} />}
          />
        )}

        {features.snippets && snippetsOpen && (
          <SnippetPanel
            sessionId={tab.sessionId}
            terminalHint={getTerminalTypeDescription(tab.sessionId)}
            onClose={() => setSnippetsOpen(false)}
          />
        )}

        {features.usb && usbOpen && (
          <WSLUSBPanel
            distro={tab.wsl?.distro ?? ""}
            connected={connected}
            onClose={() => setUsbOpen(false)}
          />
        )}

        {features.git && gitOpen && connected && tab.sessionId && cwd && (
          <GitPanel cwd={cwd} distro={tab.wsl?.distro} onClose={() => setGitOpen(false)} />
        )}

        {features.docker && dockerOpen && connected && tab.sessionId && (
          <DockerPanel distro={tab.wsl?.distro} onClose={() => setDockerOpen(false)} />
        )}
      </div>
    </div>
  );
}
