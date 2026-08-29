import { Fingerprint, RotateCw, X } from "lucide-react";

import { Button } from "@/components/ui";
import { ConnectionOverlay } from "@/components/ConnectionOverlay";
import { SftpDualPanel } from "@/components/sftp/SftpDualPanel";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

/**
 * A dedicated SFTP tab: opens a saved SSH host's session and renders the
 * dual-pane file manager (remote host on the left; the right pane defaults to
 * the local machine but can be switched to another host, with drag-and-drop
 * between the two). Credentials are resolved like SSH tabs.
 */
export function SftpWorkspace({ tab }: { tab: Tab }) {
  const t = useT();
  const closeTab = useTabsStore((s) => s.closeTab);
  const reconnect = useTabsStore((s) => s.reconnect);

  const connected = tab.status === "connected" && !!tab.sessionId;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          <span className="truncate font-medium text-fg">{tab.title}</span>
          <span className="truncate text-subtle">{tab.subtitle}</span>
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
            variant="ghost"
            size="sm"
            onClick={() => void reconnect(tab.id)}
            title={t("ws.reconnect")}
          >
            <RotateCw size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void closeTab(tab.id)}
            title={t("ws.closeSftp")}
          >
            <X size={14} />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="relative min-h-0 flex-1">
        {connected && tab.sessionId ? (
          <SftpDualPanel key={tab.sessionId} sessionId={tab.sessionId} />
        ) : (
          <ConnectionOverlay tab={tab} />
        )}
      </div>
    </div>
  );
}
