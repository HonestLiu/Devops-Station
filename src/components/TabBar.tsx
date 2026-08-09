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
    <div className="flex h-9 shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border bg-surface px-1.5 select-none">
      {tabs.map((tab) => {
        const Icon = KIND_ICON[tab.kind];
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={cn(
              "group flex min-w-[140px] max-w-[220px] cursor-pointer items-center gap-2 rounded-t px-2.5 py-1.5 text-[12px] transition-colors",
              active
                ? "bg-bg text-fg shadow-[inset_0_-2px_0_0_rgb(var(--c-accent))]"
                : "text-muted hover:bg-hover hover:text-fg",
            )}
          >
            <Icon size={13} className="shrink-0" />
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
