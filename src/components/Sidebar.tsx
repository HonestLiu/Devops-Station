import { useState } from "react";
import {
  Activity,
  Cable,
  FolderOpen,
  Info,
  LayoutDashboard,
  Microchip,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  TerminalSquare,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { isMac } from "@/lib/platform";
import { useT, type TKey } from "@/i18n";
import { useAppStore, type Page } from "@/store/useAppStore";
import { useTabsStore } from "@/store/useTabsStore";
import { NotificationBell } from "./NotificationBell";
import { AboutDialog } from "./AboutDialog";

interface NavItem {
  id: Page;
  labelKey: TKey;
  icon: typeof LayoutDashboard;
}

/** Top navigation, in display order. SFTP is a first-class page. */
const NAV: NavItem[] = [
  { id: "dashboard", labelKey: "nav.dashboard", icon: LayoutDashboard },
  { id: "hosts", labelKey: "nav.hosts", icon: Server },
  { id: "monitoring", labelKey: "nav.monitoring", icon: Activity },
  { id: "sftp", labelKey: "nav.sftp", icon: FolderOpen },
  { id: "serial", labelKey: "nav.serial", icon: Cable },
  { id: "jlink", labelKey: "nav.jlink", icon: Microchip },
  { id: "mqtt", labelKey: "nav.mqtt", icon: MessageSquare },
  { id: "settings", labelKey: "nav.settings", icon: Settings },
];

/**
 * Map a connection-tab kind to the sidebar nav item it belongs to. This is
 * what keeps the sidebar highlight in sync with whichever tab is currently
 * active: an SFTP tab lights up "SFTP", a serial/BLE tab "Serial", a J-Link tab
 * "J-Link", and any host-backed terminal (ssh/local/wsl/frp) highlights "Hosts".
 * Page-only navs (dashboard/monitoring/settings) never own a tab, so they map to
 * nothing.
 */
function navForTab(kind: string): Page | undefined {
  switch (kind) {
    case "sftp":
      return "sftp";
    case "serial":
    case "ble":
      return "serial";
    case "jlink":
      return "jlink";
    case "ssh":
    case "local":
    case "wsl":
    case "frp":
      return "hosts";
    case "mqtt":
      return "mqtt";
    default:
      return undefined;
  }
}

/** Find an already-open tab that belongs to the given sidebar nav item. */
function findTabForNav(navId: Page): string | undefined {
  const tabs = useTabsStore.getState().tabs;
  switch (navId) {
    case "sftp":
      return tabs.find((t) => t.kind === "sftp")?.id;
    case "serial":
      return tabs.find((t) => t.kind === "serial" || t.kind === "ble")?.id;
    default:
      return undefined;
  }
}

export function Sidebar() {
  const t = useT();
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const togglePalette = useAppStore((s) => s.togglePalette);
  const collapsed = useAppStore((s) => s.settings.sidebarCollapsed);
  const updateSetting = useAppStore((s) => s.updateSetting);

  const paletteShortcut = isMac ? "⌘K" : "Ctrl K";

  const focusPage = useTabsStore((s) => s.focusPage);
  const setActive = useTabsStore((s) => s.setActive);
  // The active tab drives the sidebar highlight: when a connection tab is open
  // the matching nav item lights up, so the sidebar and the current tab stay
  // in lock-step. `activeId` is the only thing that changes `navPage` (a tab's
  // kind is fixed once created), so subscribing to it is enough — and it avoids
  // re-rendering the sidebar on every tab status/title update.
  const activeId = useTabsStore((s) => s.activeId);
  const activeTabKind = activeId
    ? useTabsStore.getState().tabs.find((t) => t.id === activeId)?.kind
    : undefined;
  const navPage: Page | undefined = activeTabKind ? navForTab(activeTabKind) : page;

  const [aboutOpen, setAboutOpen] = useState(false);

  const go = (id: Page) => {
    // J-Link opens the module picker as a PAGE (not a tab), like MQTT. Picking
    // a module from it turns that module into its own singleton tab.
    if (id === "jlink") {
      setPage("jlink");
      focusPage();
      return;
    }
    // SFTP tabs are per-host and individually listed in the TabBar; from the
    // sidebar, jump to the first open one so the click still does something.
    if (id === "sftp") {
      const existing = findTabForNav("sftp");
      if (existing) {
        setActive(existing);
        return;
      }
    }
    // MQTT opens the module picker as a PAGE (not a tab). Picking a module from
    // it turns that module into its own tab.
    if (id === "mqtt") {
      setPage("mqtt");
      focusPage();
      return;
    }
    // Serial: the launcher page IS the "add another device" entry point. Always
    // open it instead of refocusing the first tab, so after connecting one port
    // you can still go back and connect a second/third. Open serial/BLE sessions
    // stay listed in the TabBar (and in the launcher's device strip) and are
    // clickable there.
    if (id === "serial") {
      setPage("serial");
      focusPage();
      return;
    }
    // Page-only navs (and the launcher pages for sftp/serial when no tab is open
    // yet) switch back to the page view and drop any active tab.
    setPage(id);
    focusPage();
  };

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-border/70 bg-surface transition-[width] duration-200",
        collapsed ? "w-14 overflow-hidden" : "w-56 overflow-visible",
      )}
    >
      {/* Brand / drag region */}
      <div
        className={cn(
          "drag-region flex h-10 items-center gap-2 select-none",
          collapsed ? "justify-center px-0" : "px-3",
        )}
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent font-mono text-[13px] font-bold text-accent-fg shadow-sm">
          {">_"}
        </div>
        {!collapsed && (
          <span className="truncate text-[13px] font-semibold text-fg">DevOps Station</span>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-2 pt-3">
        {!collapsed && (
          <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-subtle select-none">
            {t("nav.workspace")}
          </p>
        )}
        {NAV.map((item) => {
          const active = navPage === item.id;
          const Icon = item.icon;
          const label = t(item.labelKey);
          return (
            <button
              key={item.id}
              onClick={() => go(item.id)}
              title={collapsed ? label : undefined}
              className={cn(
                "flex items-center gap-2.5 rounded-lg text-[13px] transition-colors no-drag",
                collapsed ? "justify-center px-0 py-2" : "px-2.5 py-2",
                active
                  ? "bg-accent/15 font-medium text-accent ring-1 ring-inset ring-accent/25"
                  : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              <Icon size={16} strokeWidth={2} className="shrink-0" />
              {!collapsed && label}
            </button>
          );
        })}
      </nav>

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

      {/* Bottom cluster: command palette + grouped icon toolbar */}
      <div className="flex flex-col gap-1.5 border-t border-border/70 px-2 py-2">
        <button
          onClick={() => togglePalette()}
          title={collapsed ? t("nav.commandPalette") : undefined}
          className={cn(
            "no-drag flex items-center rounded-lg text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg",
            collapsed ? "justify-center px-0 py-2" : "justify-between px-2.5 py-2",
          )}
        >
          <span className={cn("flex items-center gap-2.5")}>
            <TerminalSquare size={16} strokeWidth={2} />
            {!collapsed && t("nav.commandPalette")}
          </span>
          {!collapsed && (
            <span className="rounded-full bg-bg px-1.5 py-0.5 font-mono text-[10px] text-subtle">
              {paletteShortcut}
            </span>
          )}
        </button>

        {/* Grouped icon toolbar: collapse · about · approval bell */}
        <div
          className={cn(
            "grid select-none rounded-lg bg-bg/50 p-1",
            collapsed ? "grid-cols-1" : "grid-cols-3 justify-items-center",
          )}
        >
          <button
            onClick={() => void updateSetting("sidebarCollapsed", !collapsed)}
            title={collapsed ? t("nav.expand") : t("nav.collapse")}
            className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            {collapsed ? (
              <PanelLeftOpen size={15} strokeWidth={2} />
            ) : (
              <PanelLeftClose size={15} strokeWidth={2} />
            )}
          </button>
          <button
            onClick={() => setAboutOpen(true)}
            title={t("nav.about")}
            className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <Info size={15} strokeWidth={2} />
          </button>
          <NotificationBell />
        </div>
      </div>
    </aside>
  );
}
