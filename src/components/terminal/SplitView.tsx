import { AlertTriangle, Loader2, RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { ConnectionOverlay } from "@/components/ConnectionOverlay";
import { Terminal } from "@/components/terminal/Terminal";
import { TerminalInlineAsk } from "@/ai/TerminalInlineAsk";
import { useTerminalTheme } from "@/hooks/useTerminalTheme";
import { useTabsStore } from "@/store/useTabsStore";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";
import type { Tab, TermPane } from "@/lib/types";

/** Pane-level overlay: unlike ConnectionOverlay it reconnects THIS pane. */
function PaneOverlay({ tab, pane }: { tab: Tab; pane: TermPane }) {
  const reconnect = useTabsStore((s) => s.reconnect);
  const focusPane = useTabsStore((s) => s.focusPane);

  if (pane.status === "connecting") {
    return (
      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-bg">
        <Loader2 size={22} className="animate-spin text-accent" />
        <p className="text-[12px] text-muted">Connecting…</p>
      </div>
    );
  }

  if (pane.status === "error" || pane.status === "closed") {
    return (
      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-bg/95 px-4 text-center backdrop-blur-sm">
        <AlertTriangle size={22} className="text-danger" />
        <p className="text-[12px] font-medium text-fg">
          {pane.status === "closed" ? "Connection closed" : "Connection failed"}
        </p>
        {pane.error && (
          <p className="max-w-[300px] break-words text-[11px] text-muted">{pane.error}</p>
        )}
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            focusPane(tab.id, pane.id);
            void reconnect(tab.id);
          }}
        >
          <RotateCw size={12} />
          Retry
        </Button>
      </div>
    );
  }

  return null;
}

/**
 * Split-pane SSH terminal: 1 (full), 2 (side-by-side or stacked), or 4 (2×2)
 * terminals of the same host in one tab. `tab.sessionId` always tracks the
 * focused pane so AI / cwd / SFTP consumers keep working.
 */
export function SplitView({ tab }: { tab: Tab }) {
  const t = useTerminalTheme();
  const patch = useTabsStore((s) => s.patch);
  const patchPane = useTabsStore((s) => s.patchPane);
  const focusPane = useTabsStore((s) => s.focusPane);
  const localShell = useAppStore((s) => s.settings.localShell);

  // SSH talks over ssh-* events; local/WSL/Frp sessions are PTY sessions.
  const transport = tab.kind === "ssh" ? "ssh" : "pty";
  const trackCwd = tab.kind === "ssh" || tab.kind === "wsl" || tab.kind === "local";
  // The OSC 7 emitter depends on the shell. POSIX remotes (ssh/wsl) use the
  // bash/zsh snippet; for a local tab we must tell Terminal the *actual* kind,
  // because the backend's default_shell() launches PowerShell on Windows (and the
  // login shell elsewhere). Passing "default" through would make buildCwdSetup
  // bail out and cwd tracking would never start — so resolve it here. "cmd"
  // stays inert (cmd can't emit OSC 7 reliably), which is fine.
  const isWindows =
    typeof navigator !== "undefined" && /win/i.test(navigator.userAgent || "");
  const shell =
    tab.kind === "ssh" || tab.kind === "wsl"
      ? "bash"
      : tab.kind === "local"
        ? localShell === "default"
          ? isWindows
            ? "powershell"
            : "bash"
          : localShell
        : undefined;

  const panes: TermPane[] = tab.panes ?? [
    { id: `${tab.id}-primary`, sessionId: tab.sessionId, status: tab.status },
  ];
  const count = panes.length;

  const container = cn(
    "flex min-h-0 bg-bg",
    count === 1 && "flex-col",
    count === 2 && (tab.splitAxis === "row" ? "flex-col" : "flex-row"),
    count >= 3 && "grid grid-cols-2 grid-rows-2",
  );

  const handleClosed = (paneId: string, reason: string) => {
    const current = useTabsStore.getState().tabs.find((tt) => tt.id === tab.id);
    if (current?.panes) {
      patchPane(tab.id, paneId, { status: "closed", error: reason });
    } else {
      patch(tab.id, { status: "closed", error: reason });
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className={cn(container, "min-h-0 flex-1")}>
        {panes.map((p) => {
          const focused = count > 1 && tab.focusedPaneId === p.id;
          return (
            <div
              key={p.id}
              onClick={() => count > 1 && focusPane(tab.id, p.id)}
              className={cn(
                "relative min-h-0 min-w-0 overflow-hidden bg-bg",
                count === 1 ? "h-full" : "flex-1",
                focused && "z-10 ring-2 ring-inset ring-accent/60",
              )}
            >
              {p.status === "connected" && p.sessionId ? (
                <Terminal
                  key={p.sessionId}
                  sessionId={p.sessionId}
                  transport={transport}
                  trackCwd={trackCwd}
                  shell={shell}
                  theme={t.theme}
                  fontFamily={t.fontFamily}
                  fontSize={t.fontSize}
                  lineHeight={t.lineHeight}
                  cursorBlink={t.cursorBlink}
                  cursorStyle={t.cursorStyle}
                  scrollback={t.scrollback}
                  onClosed={(info) => handleClosed(p.id, info.reason)}
                />
              ) : count === 1 ? (
                <ConnectionOverlay tab={tab} />
              ) : (
                <PaneOverlay tab={tab} pane={p} />
              )}
            </div>
          );
        })}
      </div>
      <TerminalInlineAsk tab={tab} />
    </div>
  );
}
