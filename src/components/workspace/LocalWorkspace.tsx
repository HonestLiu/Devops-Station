import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { ConnectionOverlay } from "@/components/ConnectionOverlay";
import { Terminal } from "@/components/terminal/Terminal";
import { TerminalAiButton } from "@/ai/TerminalAiButton";
import { useTerminalTheme } from "@/hooks/useTerminalTheme";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

export function LocalWorkspace({ tab }: { tab: Tab }) {
  const t = useTerminalTheme();
  const reconnect = useTabsStore((s) => s.reconnect);
  const patch = useTabsStore((s) => s.patch);
  const connected = tab.status === "connected" && !!tab.sessionId;

  return (
    <div className="flex h-full flex-col bg-bg">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <span className="text-[12px] font-medium text-fg">Local Shell</span>
        <div className="no-drag">
          <TerminalAiButton tab={tab} />
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title="Restart shell">
            <RotateCw size={14} />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {connected && tab.sessionId && (
          <Terminal
            key={tab.sessionId}
            sessionId={tab.sessionId}
            transport="pty"
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
    </div>
  );
}
