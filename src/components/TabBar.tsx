import { Cable, FolderOpen, Globe, MonitorSmartphone, Terminal, TerminalSquare, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab, TabKind } from "@/lib/types";

const KIND_ICON: Record<TabKind, typeof Terminal> = {
  ssh: Terminal,
  serial: Cable,
  wsl: TerminalSquare,
  frp: Globe,
  local: MonitorSmartphone,
  sftp: FolderOpen,
};

function statusColor(tab: Tab): string {
  switch (tab.status) {
    case "connected":
      return "bg-success";
    case "connecting":
      return "bg-accent";
    case "error":
      return "bg-danger";
    default:
      return "bg-subtle";
  }
}

export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const closeTab = useTabsStore((s) => s.closeTab);

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 bg-surface px-2 select-none">
      {tabs.map((tab) => {
        const Icon = KIND_ICON[tab.kind];
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={cn(
              "group flex h-7 min-w-[140px] max-w-[220px] cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[12px] transition-colors",
              active
                ? "bg-elevated text-fg shadow-sm ring-1 ring-inset ring-border"
                : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <Icon
              size={13}
              className={cn("shrink-0", active ? "text-accent" : "text-subtle")}
            />
            <span className="flex-1 truncate">{tab.title}</span>
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                statusColor(tab),
                tab.status === "connecting" && "pulse-dot",
              )}
              title={tab.status}
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                void closeTab(tab.id);
              }}
              className="shrink-0 rounded p-0.5 text-subtle opacity-0 hover:bg-border hover:text-fg group-hover:opacity-100"
              aria-label="Close tab"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
