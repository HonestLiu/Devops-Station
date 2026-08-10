import {
  Activity,
  FolderOpen,
  LayoutDashboard,
  Server,
  Settings,
  TerminalSquare,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore, type Page } from "@/store/useAppStore";
import { useTabsStore } from "@/store/useTabsStore";
import { NotificationBell } from "./NotificationBell";

interface NavItem {
  id: Page;
  label: string;
  icon: typeof LayoutDashboard;
}

/** Top navigation, in display order. SFTP is a first-class page. */
const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "hosts", label: "Hosts", icon: Server },
  { id: "monitoring", label: "Monitoring", icon: Activity },
  { id: "sftp", label: "SFTP", icon: FolderOpen },
  { id: "settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const togglePalette = useAppStore((s) => s.togglePalette);

  const isMac =
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent);
  const paletteShortcut = isMac ? "⌘K" : "Ctrl K";

  const tabs = useTabsStore((s) => s.tabs);
  const focusPage = useTabsStore((s) => s.focusPage);

  const go = (id: Page) => {
    setPage(id);
    focusPage();
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border/70 bg-surface">
      {/* Brand / drag region */}
      <div className="drag-region flex h-10 items-center gap-2 px-3 select-none">
        <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent font-mono text-[13px] font-bold text-accent-fg shadow-sm">
          {">_"}
        </div>
        <span className="text-[13px] font-semibold text-fg">DevOps Station</span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 pt-3">
        <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle select-none">
          Workspace
        </p>
        {NAV.map((item) => {
          const active = page === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => go(item.id)}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors no-drag",
                active
                  ? "bg-accent/15 font-medium text-accent ring-1 ring-inset ring-accent/25"
                  : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <Icon size={16} strokeWidth={2} />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Quick actions */}
      <div className="flex flex-col gap-1.5 px-2 pb-3">
        <p className="mb-0.5 px-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle select-none">
          Tools
        </p>
        <button
          onClick={() => togglePalette()}
          className="no-drag flex items-center justify-between rounded-lg border border-border/70 bg-elevated px-2.5 py-2 text-[12px] text-muted transition-colors hover:bg-hover"
        >
          <span className="flex items-center gap-2">
            <TerminalSquare size={14} />
            Command Palette
          </span>
          <span className="rounded-full bg-bg px-1.5 py-0.5 font-mono text-[10px] text-subtle">
            {paletteShortcut}
          </span>
        </button>
      </div>

      <div className="flex items-center gap-2 border-t border-border/70 px-3 py-2.5 select-none">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            tabs.length > 0 ? "bg-success" : "bg-subtle",
          )}
        />
        <span className="text-[10px] text-subtle">
          {tabs.length} connection{tabs.length === 1 ? "" : "s"} open
        </span>
        <div className="ml-auto">
          <NotificationBell />
        </div>
      </div>
    </aside>
  );
}
