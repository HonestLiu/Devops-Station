import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { ConnectionOverlay } from "@/components/ConnectionOverlay";
import { Terminal } from "@/components/terminal/Terminal";
import { TerminalInlineAsk } from "@/ai/TerminalInlineAsk";
import { useTerminalTheme } from "@/hooks/useTerminalTheme";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

/**
 * A Frp tunnel is just an `frpc` process on a PTY — its log scrolls by in the
 * terminal, and Ctrl-C (or closing the tab) stops it. Reconnect re-spawns frpc
 * with the same config kept on the tab.
 */
export function FrpWorkspace({ tab }: { tab: Tab }) {
  const tt = useTerminalTheme();
  const t = useT();
  const reconnect = useTabsStore((s) => s.reconnect);
  const patch = useTabsStore((s) => s.patch);
  const connected = tab.status === "connected" && !!tab.sessionId;

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <span className="truncate text-[12px] font-medium text-fg">{tab.title}</span>
        <div className="no-drag">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void reconnect(tab.id)}
            title={t("ws.restartTunnel")}
          >
            <RotateCw size={14} />
          </Button>
        </div>
      </div>

      <div className="flex h-full min-h-0 flex-col">
        <div className="relative min-h-0 flex-1">
          {connected && tab.sessionId && (
            <Terminal
              key={tab.sessionId}
              sessionId={tab.sessionId}
              transport="pty"
              theme={tt.theme}
              fontFamily={tt.fontFamily}
              fontSize={tt.fontSize}
              lineHeight={tt.lineHeight}
              cursorBlink={tt.cursorBlink}
              cursorStyle={tt.cursorStyle}
              scrollback={tt.scrollback}
              onClosed={(info) =>
                info.restart
                  ? void reconnect(tab.id)
                  : patch(tab.id, { status: "closed", error: info.reason })
              }
            />
          )}
          {tab.status !== "connected" && <ConnectionOverlay tab={tab} />}
        </div>
        <TerminalInlineAsk tab={tab} />
      </div>
    </div>
  );
}
