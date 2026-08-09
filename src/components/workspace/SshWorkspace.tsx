import { useState } from "react";
import { FolderClosed, FolderOpen, Fingerprint, RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { ConnectionOverlay } from "@/components/ConnectionOverlay";
import { Terminal } from "@/components/terminal/Terminal";
import { SftpPanel } from "@/components/sftp/SftpPanel";
import { TerminalAiButton } from "@/ai/TerminalAiButton";
import { useTerminalTheme } from "@/hooks/useTerminalTheme";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

export function SshWorkspace({ tab }: { tab: Tab }) {
  const [sftpOpen, setSftpOpen] = useState(false);
  const t = useTerminalTheme();
  const reconnect = useTabsStore((s) => s.reconnect);
  const patch = useTabsStore((s) => s.patch);

  const connected = tab.status === "connected" && !!tab.sessionId;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Toolbar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          <span className="truncate font-medium text-fg">{tab.title}</span>
          <span className="truncate text-subtle">{tab.subtitle}</span>
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
          <TerminalAiButton tab={tab} />
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title="Reconnect">
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
              transport="ssh"
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

        {sftpOpen && connected && tab.sessionId && (
          <SftpPanel sessionId={tab.sessionId} onClose={() => setSftpOpen(false)} />
        )}
      </div>
    </div>
  );
}
