import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { useRef } from "react";

import { Button } from "@/components/ui";
import { ConnectionOverlay } from "@/components/ConnectionOverlay";
import { Terminal } from "@/components/terminal/Terminal";
import { TerminalInlineAsk } from "@/ai/TerminalInlineAsk";
import { useTerminalTheme } from "@/hooks/useTerminalTheme";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/lib/utils";
import type { SessionClosed, Tab, TermPane } from "@/lib/types";

/** Pane-level overlay: unlike ConnectionOverlay it reconnects THIS pane. */
function PaneOverlay({ tab, pane }: { tab: Tab; pane: TermPane }) {
  const t = useT();
  const reconnect = useTabsStore((s) => s.reconnect);
  const focusPane = useTabsStore((s) => s.focusPane);

  if (pane.status === "connecting") {
    return (
      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-bg">
        <Loader2 size={22} className="animate-spin text-accent" />
        <p className="text-[12px] text-muted">{t("common.connecting")}</p>
      </div>
    );
  }

  if (pane.status === "error" || pane.status === "closed") {
    return (
      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-bg/95 px-4 text-center backdrop-blur-sm">
        <AlertTriangle size={22} className="text-danger" />
        <p className="text-[12px] font-medium text-fg">
          {pane.status === "closed" ? t("overlay.closed") : t("overlay.failed")}
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
          {t("common.retry")}
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
  const reconnect = useTabsStore((s) => s.reconnect);
  const localShell = useAppStore((s) => s.settings.localShell);

  // SSH talks over ssh-* events; local/WSL/Frp sessions are PTY sessions.
  const transport = tab.kind === "ssh" ? "ssh" : "pty";
  const trackCwd = tab.kind === "ssh" || tab.kind === "wsl" || tab.kind === "local";
  // The OSC 7 emitter depends on the shell. For a local tab we use the *resolved*
  // shell stored on the tab (`tab.shell`) — openLocal() asked the backend for the
  // real OS login shell (and a user-picked shell is stored verbatim), so this
  // always matches what was actually spawned. SSH/WSL are POSIX remotes, which
  // the bash/zsh snippet covers via self-detection. "cmd" and unknown shells
  // stay inert (buildCwdSetup returns null), which is fine.
  const shell =
    tab.kind === "ssh" || tab.kind === "wsl"
      ? "bash"
      : tab.kind === "local"
        ? tab.shell ?? (localShell !== "default" ? localShell : undefined)
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

  // Auto-restart is rate-limited: if the freshly spawned shell immediately hits
  // the same ConPTY break, we must not loop reconnect → break → reconnect.
  const lastAutoRestart = useRef<Record<string, number>>({});

  const handleClosed = (paneId: string, info: SessionClosed) => {
    // The ConPTY pipe broke while the shell process is still alive (a child
    // TUI like OpenCode exiting can tear down the whole pseudoconsole,
    // orphaning the shell). The session is unrecoverable — respawn the shell
    // in place so the tab comes back to a fresh prompt instead of a fatal
    // "连接已关闭" overlay.
    if (info.restart) {
      const now = Date.now();
      if (now - (lastAutoRestart.current[tab.id] ?? 0) < 3000) return; // no loop
      lastAutoRestart.current[tab.id] = now;
      // Defer out of the closed-event handler (avoid work inside an event
      // callback). The Terminal component keeps its xterm instance alive and
      // hot-swaps to the new session when reconnect() lands — the screen and
      // scrollback survive, only the shell is respawned.
      queueMicrotask(() => void reconnect(tab.id));
      return;
    }
    const current = useTabsStore.getState().tabs.find((tt) => tt.id === tab.id);
    if (current?.panes) {
      patchPane(tab.id, paneId, { status: "closed", error: info.reason, sessionId: undefined });
    } else {
      patch(tab.id, { status: "closed", error: info.reason, sessionId: undefined });
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
              {p.sessionId ? (
                <Terminal
                  key={p.id}
                  sessionId={p.sessionId}
                  transport={transport}
                  trackCwd={trackCwd}
                  shell={shell}
                  theme={t.theme}
                  cursorColor={t.cursorColor}
                  cursorInactiveStyle={t.cursorInactiveStyle}
                  fontFamily={t.fontFamily}
                  fontSize={t.fontSize}
                  lineHeight={t.lineHeight}
                  cursorBlink={t.cursorBlink}
                  cursorStyle={t.cursorStyle}
                  scrollback={t.scrollback}
                  onClosed={(info) => handleClosed(p.id, info)}
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
