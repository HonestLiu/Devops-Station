import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Bluetooth,
  Cable,
  ChevronsRight,
  Copy,
  FolderOpen,
  Globe,
  Microchip,
  MonitorSmartphone,
  RefreshCw,
  Terminal,
  TerminalSquare,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import { useContextMenu, type MenuItem } from "@/store/useContextMenu";
import type { Tab, TabKind } from "@/lib/types";

const KIND_ICON: Record<TabKind, typeof Terminal> = {
  ssh: Terminal,
  serial: Cable,
  ble: Bluetooth,
  wsl: TerminalSquare,
  frp: Globe,
  local: MonitorSmartphone,
  sftp: FolderOpen,
  jlink: Microchip,
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
  const t = useT();
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const closeTab = useTabsStore((s) => s.closeTab);
  const duplicateTab = useTabsStore((s) => s.duplicateTab);
  const reconnect = useTabsStore((s) => s.reconnect);

  const showCtx = useContextMenu((s) => s.show);
  const closeCtx = useContextMenu((s) => s.close);

  const onTabContextMenu = (e: ReactMouseEvent, tab: Tab) => {
    e.preventDefault();
    e.stopPropagation();
    const idx = tabs.findIndex((t) => t.id === tab.id);
    const items: MenuItem[] = [
      {
        id: "duplicate",
        label: t("tabs.duplicate"),
        icon: <Copy size={14} />,
        onClick: () => {
          closeCtx();
          void duplicateTab(tab.id);
        },
      },
      {
        id: "close",
        label: t("tabs.close"),
        icon: <X size={14} />,
        onClick: () => {
          closeCtx();
          void closeTab(tab.id);
        },
      },
      {
        id: "close-others",
        label: t("tabs.closeOthers"),
        icon: <X size={14} />,
        onClick: () => {
          closeCtx();
          tabs.filter((t) => t.id !== tab.id).forEach((t) => void closeTab(t.id));
        },
      },
      {
        id: "close-right",
        label: t("tabs.closeRight"),
        icon: <ChevronsRight size={14} />,
        onClick: () => {
          closeCtx();
          tabs.slice(idx + 1).forEach((t) => void closeTab(t.id));
        },
      },
    ];
    if (tab.status !== "connected") {
      items.push({ id: "sep", separator: true, label: "" });
      items.push({
        id: "reconnect",
        label: t("tabs.reconnect"),
        icon: <RefreshCw size={14} />,
        onClick: () => {
          closeCtx();
          void reconnect(tab.id);
        },
      });
    }
    showCtx(e.clientX, e.clientY, items);
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 bg-surface px-2 select-none">
      {tabs.map((tab) => {
        const Icon = KIND_ICON[tab.kind];
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            onClick={() => setActive(tab.id)}
            onContextMenu={(e) => onTabContextMenu(e, tab)}
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
              aria-label={t("tabs.closeAria")}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
