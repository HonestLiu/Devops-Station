import {
  Activity,
  LayoutDashboard,
  Server,
  Settings,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAppStore, type Page } from "@/store/useAppStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useAiStore } from "@/ai/useAiStore";

interface NavItem {
  id: Page;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "hosts", label: "Hosts", icon: Server },
  { id: "monitoring", label: "Monitoring", icon: Activity },
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

  const aiOpen = useAiStore((s) => s.panelOpen);
  const tabs = useTabsStore((s) => s.tabs);
  const focusPage = useTabsStore((s) => s.focusPage);

  const go = (id: Page) => {
    setPage(id);
    focusPage();
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
        {NAV.map((item) => {
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
