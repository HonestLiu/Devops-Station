import { useMemo, useState } from "react";
import {
  Activity,
  FolderOpen,
  LayoutDashboard,
  Server,
  Settings,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore, type Page } from "@/store/useAppStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useHostsStore } from "@/store/useHostsStore";
import { useAiStore } from "@/ai/useAiStore";

type SidebarEntry =
  | { kind: "page"; id: Page; label: string; icon: typeof LayoutDashboard }
  | { kind: "sftp"; label: string; icon: typeof FolderOpen };

/** Top navigation, in display order. SFTP sits with the primary pages. */
const SIDEBAR: SidebarEntry[] = [
  { kind: "page", id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { kind: "page", id: "hosts", label: "Hosts", icon: Server },
  { kind: "page", id: "monitoring", label: "Monitoring", icon: Activity },
  { kind: "sftp", label: "SFTP", icon: FolderOpen },
  { kind: "page", id: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const togglePalette = useAppStore((s) => s.togglePalette);
  const [sftpOpen, setSftpOpen] = useState(false);

  const isMac =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
  const paletteShortcut = isMac ? "⌘K" : "Ctrl K";

  const aiOpen = useAiStore((s) => s.panelOpen);
  const tabs = useTabsStore((s) => s.tabs);
  const focusPage = useTabsStore((s) => s.focusPage);
  const openSftp = useTabsStore((s) => s.openSftp);
  const hosts = useHostsStore((s) => s.hosts);
  const sshHosts = useMemo(() => hosts.filter((h) => h.kind === "ssh"), [hosts]);

  const go = (id: Page) => {
    setPage(id);
    focusPage();
  };

  const pickSftp = (hostId: string) => {
    const host = sshHosts.find((h) => h.id === hostId);
    setSftpOpen(false);
    if (host) void openSftp(host, host.name);
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
      {/* Brand / drag region */}
      <div className="drag-region flex h-9 items-center gap-2 px-3 select-none">
        <div className="flex h-6 w-6 items-center justify-center rounded bg-accent font-mono text-[13px] font-bold text-accent-fg">
          {">_"}
        </div>
        <span className="text-[13px] font-semibold text-fg">DevOps Station</span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-2 pt-2">
        {SIDEBAR.map((item) => {
          if (item.kind === "page") {
            const active = page === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                onClick={() => go(item.id)}
                className={cn(
                  "flex items-center gap-2.5 rounded px-2.5 py-2 text-[13px] transition-colors no-drag",
                  active
                    ? "bg-accent/15 font-medium text-accent"
                    : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <Icon size={16} strokeWidth={2} />
                {item.label}
              </button>
            );
          }

          // SFTP — a first-class entry: opens a dedicated SFTP tab on a saved SSH host.
          const Icon = item.icon;
          return (
            <div key="sftp" className="relative">
              <button
                onClick={() => setSftpOpen((v) => !v)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded px-2.5 py-2 text-[13px] transition-colors no-drag",
                  sftpOpen
                    ? "bg-accent/15 font-medium text-accent"
                    : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <Icon size={16} strokeWidth={2} />
                SFTP
                <span
                  className={cn(
                    "ml-auto rounded px-1.5 py-0.5 font-mono text-[10px]",
                    sftpOpen ? "bg-accent/20 text-accent" : "bg-bg text-subtle",
                  )}
                >
                  {sshHosts.length}
                </span>
              </button>
              {sftpOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setSftpOpen(false)} />
                  <div className="absolute left-full top-0 z-50 ml-2 w-64 overflow-hidden rounded-lg border border-border bg-elevated shadow-xl">
                    <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                      Open SFTP on saved SSH host
                    </div>
                    {sshHosts.length === 0 ? (
                      <div className="px-3 py-3 text-[12px] text-subtle">
                        No saved SSH hosts yet.
                        <button
                          onClick={() => {
                            setSftpOpen(false);
                            go("hosts");
                          }}
                          className="mt-2 block w-full rounded-md border border-border px-2 py-1.5 text-left text-[12px] text-fg hover:bg-hover"
                        >
                          Go to Hosts to add one →
                        </button>
                      </div>
                    ) : (
                      <div className="max-h-64 overflow-y-auto py-1">
                        {sshHosts.map((h) => (
                          <button
                            key={h.id}
                            onClick={() => pickSftp(h.id)}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-hover"
                            title={`${h.hostname}:${h.port ?? 22}`}
                          >
                            <FolderOpen size={13} className="shrink-0 text-muted" />
                            <span className="truncate">{h.name}</span>
                            <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-subtle">
                              {h.username ? `${h.username}@` : ""}
                              {h.hostname}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </nav>

      {/* Quick actions */}
      <div className="flex flex-col gap-1.5 px-2 pb-3">
        <button
          onClick={() => useAiStore.getState().togglePanel()}
          className={cn(
            "no-drag flex items-center gap-2 rounded border border-border bg-elevated px-2.5 py-2 text-[12px] hover:bg-hover",
            aiOpen ? "text-accent" : "text-muted",
          )}
        >
          <Sparkles size={14} />
          AI Assistant
          <span className="ml-auto rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-subtle">
            ⌘.
          </span>
        </button>
        <button
          onClick={() => togglePalette()}
          className="no-drag flex items-center justify-between rounded border border-border bg-elevated px-2.5 py-2 text-[12px] text-muted hover:bg-hover"
        >
          <span className="flex items-center gap-2">
            <TerminalSquare size={14} />
            Command Palette
          </span>
          <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-subtle">
            {paletteShortcut}
          </span>
        </button>
      </div>

      <div className="border-t border-border px-3 py-2 text-[10px] text-subtle select-none">
        {tabs.length} connection{tabs.length === 1 ? "" : "s"} open
      </div>
    </aside>
  );
}
