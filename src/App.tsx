import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Cable,
  ClipboardPaste,
  Copy,
  FolderOpen,
  ListChecks,
  MessageSquare,
  Microchip,
  MonitorSmartphone,
  Scissors,
  Server,
  Settings as SettingsIcon,
  X,
} from "lucide-react";

import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { CommandPalette } from "./components/CommandPalette";
import { ContextMenu } from "./components/ContextMenu";

import { Dashboard } from "./pages/Dashboard";
import { Hosts } from "./pages/Hosts";
import { Monitoring } from "./pages/Monitoring";
import { Settings } from "./pages/Settings";
import { SftpPage } from "./pages/SftpPage";
import { SerialPage } from "./pages/SerialPage";
import { JLinkPage } from "./pages/JLinkPage";
import { MqttPage } from "./pages/MqttPage";
import { DashPage } from "./pages/DashPage";

import { SshWorkspace } from "./components/workspace/SshWorkspace";
import { SerialWorkspace } from "./components/workspace/SerialWorkspace";
import { SerialLauncher } from "./components/serial/SerialLauncher";
import { SerialDesignerModule } from "./components/serial/designer/SerialDesignerModule";
import { LocalWorkspace } from "./components/workspace/LocalWorkspace";
import { WslWorkspace } from "./components/workspace/WslWorkspace";
import { FrpWorkspace } from "./components/workspace/FrpWorkspace";
import { SftpWorkspace } from "./components/workspace/SftpWorkspace";
import { JLinkWorkspace } from "./components/workspace/JLinkWorkspace";
import { MqttWorkspace } from "./components/workspace/MqttWorkspace";
import { AiPanel } from "./ai/AiPanel";
import { useAiStore } from "./ai/useAiStore";

import { useAppStore, type Page } from "./store/useAppStore";
import { useTabsStore } from "./store/useTabsStore";
import { usePermStore } from "./store/usePermStore";
import { useContextMenu, type MenuItem } from "./store/useContextMenu";
import { useT } from "./i18n";
import { cn } from "./lib/utils";
import { checkForUpdate } from "./lib/updater";
import { permHook } from "./lib/api";
import { pullSync, isSyncConfigured } from "./lib/sync";
import { UpdateDialog } from "./components/UpdateDialog";
import { HostKeyPrompt } from "./components/HostKeyPrompt";
import { approveWaitingNow } from "./lib/quickApprove";
import { focusActiveTerminal } from "./ai/terminalBridge";
import {
  isShortcutRecording,
  parseShortcut,
  shortcutToAccelerator,
  type Shortcut,
} from "./lib/shortcut";
import { SHORTCUT_DEFS, isSplitShortcut } from "./lib/shortcuts";
import type { PermRequest, ShortcutId, Tab } from "./lib/types";

function PageContent({ page }: { page: Page }) {
  switch (page) {
    case "dashboard":
      return <Dashboard />;
    case "hosts":
      return <Hosts />;
    case "monitoring":
      return <Monitoring />;
    case "settings":
      return <Settings />;
    case "sftp":
      return <SftpPage />;
    case "serial":
      return <SerialPage />;
    case "jlink":
      return <JLinkPage />;
    case "mqtt":
      return <MqttPage />;
  }
}

/**
 * Run a split/close/focus-pane shortcut against the active tab. Only consumes
 * the keystroke (preventDefault/stopPropagation) when an action actually fires,
 * so a single-pane terminal still receives e.g. Ctrl+Shift+Arrow for the shell.
 * Returns true when the event was handled.
 */
function dispatchSplit(
  id: ShortcutId,
  e: KeyboardEvent,
  tab: Tab,
  ts: ReturnType<typeof useTabsStore.getState>,
): boolean {
  const guard = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  switch (id) {
    case "splitPaneCol":
      guard();
      void ts.splitPane(tab.id, "col");
      return true;
    case "splitPaneRow":
      guard();
      void ts.splitPane(tab.id, "row");
      return true;
    case "closePane": {
      const fid = tab.focusedPaneId ?? tab.panes?.[0]?.id;
      if (!fid || (tab.panes?.length ?? 0) <= 1) return false;
      guard();
      void ts.closePane(tab.id, fid);
      return true;
    }
    case "focusPaneLeft":
    case "focusPaneRight":
    case "focusPaneUp":
    case "focusPaneDown": {
      if (!tab.panes || tab.panes.length < 2) return false;
      const order = tab.panes.map((p) => p.id);
      const cur = order.indexOf(tab.focusedPaneId ?? order[0]);
      const leftUp = id === "focusPaneLeft" || id === "focusPaneUp";
      const next = leftUp
        ? Math.max(0, cur - 1)
        : Math.min(order.length - 1, cur + 1);
      guard();
      ts.focusPane(tab.id, order[next]);
      return true;
    }
    default:
      return false;
  }
}

function TabContent({ tab }: { tab: Tab }) {
  if (tab.kind === "ssh") return <SshWorkspace tab={tab} />;
  // Serial module tabs (picker-launched) host the launcher / designer instead
  // of a live serial session — same kind, distinguished by `serialModule`.
  if (tab.serialModule === "basic") return <SerialLauncher />;
  if (tab.serialModule === "designer") return <SerialDesignerModule />;
  if (tab.kind === "serial" || tab.kind === "ble") return <SerialWorkspace tab={tab} />;
  if (tab.kind === "wsl") return <WslWorkspace tab={tab} />;
  if (tab.kind === "frp") return <FrpWorkspace tab={tab} />;
  if (tab.kind === "sftp") return <SftpWorkspace tab={tab} />;
  if (tab.kind === "jlink") return <JLinkWorkspace tab={tab} />;
  // `mqtt` with a profile is a live connection; `mqttModule: "dash"` is the
  // HMI dashboard module tab opened from the module picker page.
  if (tab.kind === "mqtt" && tab.mqtt) return <MqttWorkspace tab={tab} />;
  if (tab.kind === "mqtt" && tab.mqttModule === "dash") return <DashPage />;
  if (tab.kind === "mqtt") return <MqttPage />;
  return <LocalWorkspace tab={tab} />;
}

export default function App() {
  const t = useT();
  const page = useAppStore((s) => s.page);
  const togglePalette = useAppStore((s) => s.togglePalette);

  const openLocal = useTabsStore((s) => s.openLocal);
  const setPageCtx = useAppStore((s) => s.setPage);
  const showCtx = useContextMenu((s) => s.show);
  const closeCtx = useContextMenu((s) => s.close);

  // Fully take over the right mouse button: suppress the native menu everywhere
  // and show our own menu. Text fields get an app-style cut/copy/paste/select-all
  // menu instead of the WebView2 native one.
  const onRootContextMenu = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement | null;
    e.preventDefault();

    // Text fields & contenteditable: app-style editing menu. We must NOT let
    // the event reach the WebView2 default handler — that would pop the native
    // OS menu (inconsistent styling) instead of ours.
    const inputEl = target?.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    const richEl = target?.closest<HTMLElement>('[contenteditable="true"], [contenteditable=""]');
    if (inputEl || richEl) {
      const rich = !!richEl;
      const el = rich ? richEl! : inputEl!;
      const selectedText = rich
        ? window.getSelection()?.toString() ?? ""
        : String(inputEl!.value).slice(inputEl!.selectionStart ?? 0, inputEl!.selectionEnd ?? 0);
      const hasSelection = rich
        ? !!selectedText
        : (inputEl!.selectionStart ?? 0) !== (inputEl!.selectionEnd ?? 0);
      const hasText = rich ? !!(el.textContent ?? "").length : String(inputEl!.value).length > 0;
      // The menu button steals focus when clicked; execCommand("cut"/"paste")
      // acts on the focused field, so restore focus before running it.
      const focusField = () => el.focus();
      showCtx(e.clientX, e.clientY, [
        {
          id: "cut",
          label: t("common.cut"),
          icon: <Scissors size={14} />,
          disabled: !hasSelection,
          onClick: () => {
            focusField();
            document.execCommand("cut");
          },
        },
        {
          id: "copy",
          label: t("common.copy"),
          icon: <Copy size={14} />,
          disabled: !hasSelection,
          onClick: () => {
            void navigator.clipboard.writeText(selectedText);
          },
        },
        {
          id: "paste",
          label: t("common.paste"),
          icon: <ClipboardPaste size={14} />,
          onClick: () => {
            focusField();
            document.execCommand("paste");
          },
        },
        { id: "sep", separator: true, label: "" },
        {
          id: "selectAll",
          label: t("common.selectAll"),
          icon: <ListChecks size={14} />,
          disabled: !hasText,
          onClick: () => {
            el.focus();
            if (rich) document.execCommand("selectAll");
            else inputEl!.select();
          },
        },
      ]);
      return;
    }

    // Right-click over a text selection gets a Copy item first — the native
    // menu is suppressed app-wide, so without this there'd be no way to copy
    // selected text outside of inputs (e.g. the AI chat history).
    const sel = window.getSelection()?.toString().trim() ?? "";

    // The AI chat panel is a read-only content surface: right-click there only
    // offers Copy (when text is selected) — the app-navigation items that make
    // sense on page chrome don't apply inside a conversation.
    if (target?.closest('[data-context="ai"]')) {
      if (!sel) return;
      showCtx(e.clientX, e.clientY, [
        {
          id: "copy",
          label: t("common.copy"),
          icon: <Copy size={14} />,
          onClick: () => {
            closeCtx();
            void navigator.clipboard.writeText(sel);
          },
        },
      ]);
      return;
    }

    const items: MenuItem[] = [];
    if (sel) {
      items.push(
        {
          id: "copy",
          label: t("common.copy"),
          icon: <Copy size={14} />,
          onClick: () => {
            closeCtx();
            void navigator.clipboard.writeText(sel);
          },
        },
        { id: "sep-copy", separator: true, label: "" },
      );
    }
    items.push(
      {
        id: "local",
        label: t("app.newLocalTerminal"),
        icon: <MonitorSmartphone size={14} />,
        onClick: () => {
          closeCtx();
          void openLocal();
        },
      },
      { id: "sep1", separator: true, label: "" },
      {
        id: "hosts",
        label: t("app.openHosts"),
        icon: <Server size={14} />,
        onClick: () => {
          closeCtx();
          setPageCtx("hosts");
        },
      },
      {
        id: "serial",
        label: t("app.openSerial"),
        icon: <Cable size={14} />,
        onClick: () => {
          closeCtx();
          setPageCtx("serial");
        },
      },
      {
        id: "jlink",
        label: t("app.openJlink"),
        icon: <Microchip size={14} />,
        onClick: () => {
          closeCtx();
          setPageCtx("jlink");
          useTabsStore.getState().focusPage();
        },
      },
      {
        id: "sftp",
        label: t("app.openSftp"),
        icon: <FolderOpen size={14} />,
        onClick: () => {
          closeCtx();
          setPageCtx("sftp");
        },
      },
      {
        id: "mqtt",
        label: t("app.openMqtt"),
        icon: <MessageSquare size={14} />,
        onClick: () => {
          closeCtx();
          setPageCtx("mqtt");
          useTabsStore.getState().focusPage();
        },
      },
      { id: "sep2", separator: true, label: "" },
      {
        id: "settings",
        label: t("app.settings"),
        icon: <SettingsIcon size={14} />,
        onClick: () => {
          closeCtx();
          setPageCtx("settings");
        },
      },
    );
    showCtx(e.clientX, e.clientY, items);
  };

  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const ungroupTab = useTabsStore((s) => s.ungroupTab);
  const activeTab = tabs.find((t) => t.id === activeId);

  const showTabs = tabs.length > 0;

  // Unified app-wide shortcut dispatch. Every configurable shortcut (Settings →
  // Shortcuts, registry in src/lib/shortcuts.ts) is matched here in the CAPTURE
  // phase and stopPropagation'd so the keystroke never reaches a focused xterm.
  // Stands down while Settings is recording a shortcut (the recorder's own
  // listener must consume the keystroke). First match in SHORTCUT_DEFS order
  // wins, so a duplicate binding resolves deterministically.
  const toggleAi = useAiStore((s) => s.togglePanel);
  const shortcuts = useAppStore((s) => s.settings.shortcuts);
  const parsedShortcuts = useMemo(() => {
    const m = new Map<ShortcutId, Shortcut>();
    for (const def of SHORTCUT_DEFS) {
      const b = shortcuts?.[def.id];
      if (!b?.enabled) continue;
      const s = parseShortcut(b.spec);
      if (s) m.set(def.id, s);
    }
    return m;
  }, [shortcuts]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutRecording()) return;
      for (const def of SHORTCUT_DEFS) {
        const s = parsedShortcuts.get(def.id);
        if (!s) continue;
        if (
          e.ctrlKey !== s.ctrl ||
          e.shiftKey !== s.shift ||
          e.altKey !== s.alt ||
          e.metaKey !== s.meta ||
          e.code !== s.code
        ) {
          continue;
        }

        if (isSplitShortcut(def.id)) {
          // Split/close/focus only applies to SSH/Local/WSL tabs; otherwise let
          // the keystroke fall through to the shell (e.g. Ctrl+Shift+Arrow in a
          // single-pane terminal).
          const ts = useTabsStore.getState();
          const tab = ts.tabs.find((t) => t.id === ts.activeId);
          if (!tab || !["ssh", "local", "wsl"].includes(tab.kind)) continue;
          if (!dispatchSplit(def.id, e, tab, ts)) continue;
          return;
        }

        e.preventDefault();
        e.stopPropagation();
        if (def.id === "quickApprove") void approveWaitingNow();
        else if (def.id === "toggleAi") toggleAi();
        else if (def.id === "togglePalette") togglePalette();
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [parsedShortcuts, toggleAi, togglePalette]);
  // Permission-request alerts from the backend (vibecoding CLI approval prompts).
  // The OS-level notification is raised in Rust; here we just feed the in-app bell.
  useEffect(() => {
    const un = listen<PermRequest>("perm-request", (e) => {
      usePermStore.getState().push(e.payload);
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  // When the window regains focus (e.g. Alt+Tab back), put keyboard focus back
  // on the active terminal so typing works immediately without a click. Text
  // fields are left alone — the user may have been typing in the inline ask /
  // AI panel before switching away (an xterm's internal helper textarea also
  // matches TEXTAREA, which is fine: it means the terminal is already focused).
  useEffect(() => {
    const onWinFocus = () => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      focusActiveTerminal();
    };
    window.addEventListener("focus", onWinFocus);
    return () => window.removeEventListener("focus", onWinFocus);
  }, []);

  // Approval HOOK service lifecycle: keep the local listener and the legacy
  // scan switch in sync with Settings. Started once settings have loaded so the
  // persisted port/toggles take effect; re-applied on any change.
  const settingsLoaded = useAppStore((s) => s.settingsLoaded);
  const approval = useAppStore((s) => s.settings.approval);
  useEffect(() => {
    if (!settingsLoaded) return;
    void permHook.setScanFallback(approval.scanFallback).catch(() => undefined);
    if (approval.enabled) {
      const managed = (Object.keys(approval.tools) as (keyof typeof approval.tools)[])
        .filter((k) => approval.tools[k])
        .map((k) => String(k));
      void permHook.start(approval.port, managed).catch(() => undefined);
    } else {
      void permHook.stop().catch(() => undefined);
    }
  }, [settingsLoaded, approval.enabled, approval.port, approval.scanFallback]);

  // Auto-pull cloud config on startup when a sync target is configured
  // (silent — failures just leave the local state as-is; the user can sync
  // manually in Settings).
  const syncConfigured = useAppStore((s) => isSyncConfigured());
  useEffect(() => {
    if (!settingsLoaded) return;
    if (syncConfigured) {
      void pullSync().catch(() => undefined);
    }
  }, [settingsLoaded, syncConfigured]);

  // Keep the OS-level (system-wide) quick-approve shortcut in sync with the
  // setting — it works even when this window has no focus, e.g. the user is
  // watching Claude Code in a separate terminal window. The in-window keydown is
  // handled by the unified dispatch above; the master toggle unregisters the OS
  // hotkey entirely so it never fires while disabled.
  const quickApprove = useAppStore((s) => s.settings.shortcuts?.quickApprove);
  useEffect(() => {
    if (!settingsLoaded) return;
    const acc = quickApprove?.enabled
      ? shortcutToAccelerator(quickApprove.spec)
      : null;
    void permHook.setGlobalShortcut(acc).catch((e) =>
      console.error("[shortcut] failed to register global approve shortcut:", e),
    );
  }, [settingsLoaded, quickApprove?.spec, quickApprove?.enabled]);

  // OS-level quick-approve shortcut (tauri-plugin-global-shortcut): fires even
  // when the app window has no focus (e.g. the user is looking at Claude Code
  // in a separate terminal window). The Rust side re-registers it whenever
  // settings.shortcuts.quickApprove changes; here we just react to the event.
  useEffect(() => {
    const un = listen("approval-shortcut", () => {
      void approveWaitingNow();
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  // Auto-check for a newer release a couple of seconds after launch. Silent when
  // there's nothing new (the dialog only opens if an update is found). Guarded so
  // React StrictMode's double-mount in dev doesn't fire it twice, and respects the
  // "Automatically check for updates on startup" setting once settings are loaded.
  const autoCheckUpdates = useAppStore((s) => s.settings.autoCheckUpdates);
  const didAutoCheck = useRef(false);
  useEffect(() => {
    if (!settingsLoaded || didAutoCheck.current) return;
    if (!autoCheckUpdates) return;
    didAutoCheck.current = true;
    const id = window.setTimeout(() => {
      void checkForUpdate(false, true);
    }, 2500);
    return () => window.clearTimeout(id);
  }, [settingsLoaded, autoCheckUpdates]);

  return (
    <div
      className="flex h-full w-full overflow-hidden bg-bg text-fg"
      onContextMenu={onRootContextMenu}
    >
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {showTabs && <TabBar />}
        <main className="relative min-h-0 flex-1 overflow-hidden">
          {/*
            Every open tab stays mounted — and, crucially, every tab keeps the
            SAME position in the component tree (one container, one child per
            tab, keyed by tab.id). Split-grouping is expressed purely through
            CSS layout classes, never by moving children between parents: moving
            a TabContent across trees would unmount/remount its xterm, replaying
            the shell init (duplicate OSC 7 injection) and freezing the session.

            The active region (a standalone tab, or a group of tabs) fills the
            grid; inactive tabs become `invisible absolute inset-0` so they keep
            layout size (FitAddon can measure) without occupying a grid cell.
          */}
          {(() => {
            // Which region is on screen: the active tab's group, or itself.
            const regionTabs = activeTab?.group
              ? tabs.filter((t) => t.group === activeTab.group)
              : activeTab
                ? [activeTab]
                : [];
            const size = regionTabs.length;
            const containerCls =
              size <= 1
                ? "block"
                : size === 2
                  ? "grid grid-cols-2"
                  : "grid grid-cols-2 grid-rows-2";
            return (
              <div className={cn("absolute inset-0 h-full bg-bg", containerCls)}>
                {tabs.map((tab) => {
                  const inRegion = activeTab
                    ? tab.group
                      ? activeTab.group === tab.group
                      : activeTab.id === tab.id
                    : false;
                  return (
                    <div
                      key={tab.id}
                      onClick={(e) => {
                        // Ignore clicks on interactive controls inside the tab:
                        // a child handler (e.g. a "连接" button that opens
                        // another tab via openMqtt) may have just switched the
                        // active tab — bubbling here would yank it right back.
                        const target = e.target as HTMLElement;
                        if (target.closest("button, a, input, select, textarea, [role='button']")) return;
                        setActive(tab.id);
                      }}
                      aria-hidden={!inRegion}
                      className={cn(
                        "relative min-h-0 min-w-0 overflow-hidden bg-bg",
                        inRegion
                          ? size <= 1
                            ? "h-full w-full"
                            : "min-h-0 min-w-0"
                          : "invisible pointer-events-none absolute inset-0",
                        tab.group && tab.id === activeId && "ring-2 ring-inset ring-accent/50",
                      )}
                    >
                      <TabContent tab={tab} />
                      {tab.group && inRegion && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            ungroupTab(tab.id);
                          }}
                          title={t("tabs.ungroup")}
                          className="absolute right-2 top-11 z-30 flex h-6 w-6 items-center justify-center rounded-md bg-bg/80 text-subtle opacity-60 transition-opacity hover:bg-border hover:text-danger hover:opacity-100"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {!activeTab && (
            <div className="absolute inset-0 z-20 bg-bg">
              <PageContent page={page} />
            </div>
          )}
        </main>
      </div>
      <AiPanel />
      <CommandPalette />
      <ContextMenu />
      <UpdateDialog />
      <HostKeyPrompt />
    </div>
  );
}
