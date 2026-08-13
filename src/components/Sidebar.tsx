import { useState } from "react";
import {
  Activity,
  Cable,
  FolderOpen,
  Info,
  LayoutDashboard,
  Microchip,
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
  { id: "settings", labelKey: "nav.settings", icon: Settings },
];

export function Sidebar() {
  const t = useT();
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const togglePalette = useAppStore((s) => s.togglePalette);
  const collapsed = useAppStore((s) => s.settings.sidebarCollapsed);
  const updateSetting = useAppStore((s) => s.updateSetting);

  const paletteShortcut = isMac ? "⌘K" : "Ctrl K";

  const tabs = useTabsStore((s) => s.tabs);
  const focusPage = useTabsStore((s) => s.focusPage);
  const openJlink = useTabsStore((s) => s.openJlink);

  const [aboutOpen, setAboutOpen] = useState(false);

  const go = (id: Page) => {
    // J-Link opens as a persistent tab (its panel state survives tab
    // switches) rather than a page that would reset when you navigate away.
    if (id === "jlink") {
      void openJlink();
      return;
    }
    setPage(id);
    focusPage();
  };

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col overflow-hidden border-r border-border/70 bg-surface transition-[width] duration-200",
        collapsed ? "w-14" : "w-56",
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
          const active = page === item.id;
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

      {/* Bottom cluster: utility actions + connection status + collapse toggle */}
      <div className="flex flex-col gap-0.5 border-t border-border/70 px-2 py-2">
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

        <button
          onClick={() => setAboutOpen(true)}
          title={collapsed ? t("nav.about") : undefined}
          className={cn(
            "no-drag flex items-center rounded-lg text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg",
            collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-2",
          )}
        >
          <Info size={16} strokeWidth={2} className="shrink-0" />
          {!collapsed && t("nav.about")}
        </button>

        {!collapsed && (
          <div className="flex items-center gap-2 px-1 pt-1.5 select-none">
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                tabs.length > 0 ? "bg-success" : "bg-subtle",
              )}
            />
            <span className="truncate text-[10px] text-subtle">
              {t("nav.connections", { n: tabs.length, s: tabs.length === 1 ? "" : "s" })}
            </span>
          </div>
        )}

        {/* Collapse toggle */}
        <button
          onClick={() => void updateSetting("sidebarCollapsed", !collapsed)}
          title={collapsed ? t("nav.expand") : t("nav.collapse")}
          className={cn(
            "no-drag mt-1 flex items-center rounded-lg border-t border-border/40 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg",
            collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-2",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} strokeWidth={2} className="shrink-0" />
          ) : (
            <PanelLeftClose size={16} strokeWidth={2} className="shrink-0" />
          )}
          {!collapsed && t("nav.collapse")}
        </button>
      </div>
    </aside>
  );
}
