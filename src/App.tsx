import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
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

import { SshWorkspace } from "./components/workspace/SshWorkspace";
import { SerialWorkspace } from "./components/workspace/SerialWorkspace";
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
import { pullSyncData } from "./lib/sync";
import { UpdateDialog } from "./components/UpdateDialog";
import { HostKeyPrompt } from "./components/HostKeyPrompt";
import { approveWaitingNow } from "./lib/quickApprove";
import { focusActiveTerminal } from "./ai/terminalBridge";
import {
  isShortcutRecording,
  matchesShortcut,
  shortcutToAccelerator,
} from "./lib/shortcut";
import type { PermRequest, Tab } from "./lib/types";

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

function TabContent({ tab }: { tab: Tab }) {
  if (tab.kind === "ssh") return <SshWorkspace tab={tab} />;
  if (tab.kind === "serial" || tab.kind === "ble") return <SerialWorkspace tab={tab} />;
  if (tab.kind === "wsl") return <WslWorkspace tab={tab} />;
  if (tab.kind === "frp") return <FrpWorkspace tab={tab} />;
  if (tab.kind === "sftp") return <SftpWorkspace tab={tab} />;
  if (tab.kind === "jlink") return <JLinkWorkspace tab={tab} />;
  if (tab.kind === "mqtt") return <MqttWorkspace tab={tab} />;
  return <LocalWorkspace tab={tab} />;
}

export default function App() {
  const t = useT();
  const page = useAppStore((s) => s.page);
  const togglePalette = useAppStore((s) => s.togglePalette);

  const openLocal = useTabsStore((s) => s.openLocal);
  const openJlink = useTabsStore((s) => s.openJlink);
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
          void openJlink();
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

  // Toggle the AI panel with Cmd+. (macOS) / Ctrl+. (Windows/Linux), capture phase
  // so it wins over the terminal.
  const toggleAi = useAiStore((s) => s.togglePanel);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutRecording()) return;
      if ((e.metaKey || e.ctrlKey) && e.code === "Period") {
        e.preventDefault();
        e.stopPropagation();
        toggleAi();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggleAi]);
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

  // Auto-pull cloud config on startup when logged in (silent — failures just
  // leave the local state as-is; the user can sync manually in Settings).
  const account = useAppStore((s) => s.settings.account);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (account.token) {
      void pullSyncData(account.serverUrl, account.token).catch(() => undefined);
    }
  }, [settingsLoaded, account.token, account.serverUrl]);

  // Quick approval shortcut (configurable in Settings → Shortcuts): sends Enter
  // to the session that is currently waiting on an agent CLI approval prompt
  // (Claude Code, Codex, …), confirming the highlighted "Yes" option. In-window
  // keydown (capture phase + stopPropagation so the keystroke never reaches the
  // terminal) — the OS-level registration below covers the no-focus case; the
  // 400ms dedup in approveWaitingNow keeps the two from double-sending Enter.
  const approveShortcut = useAppStore((s) => s.settings.approveShortcut);
  const approveShortcutEnabled = useAppStore((s) => s.settings.approveShortcutEnabled);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Stand down while Settings is recording a shortcut: the recorder's own
      // listener must be the one to consume the keystroke (capture-order).
      if (isShortcutRecording()) return;
      if (!approveShortcutEnabled) return;
      if (matchesShortcut(e, approveShortcut)) {
        e.preventDefault();
        e.stopPropagation();
        void approveWaitingNow();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [approveShortcut, approveShortcutEnabled]);

  // Keep the OS-level (system-wide) quick-approve shortcut in sync with the
  // setting — it works even when this window has no focus, e.g. the user is
  // watching Claude Code in a separate terminal window. The master toggle
  // unregisters it entirely so the hotkey never fires while disabled.
  useEffect(() => {
    if (!settingsLoaded) return;
    const acc = approveShortcutEnabled ? shortcutToAccelerator(approveShortcut) : null;
    void permHook.setGlobalShortcut(acc).catch((e) =>
      console.error("[shortcut] failed to register global approve shortcut:", e),
    );
  }, [settingsLoaded, approveShortcut, approveShortcutEnabled]);

  // OS-level quick-approve shortcut (tauri-plugin-global-shortcut): fires even
  // when the app window has no focus (e.g. the user is looking at Claude Code
  // in a separate terminal window). The Rust side re-registers it whenever
  // settings.approveShortcut changes; here we just react to the event.
  useEffect(() => {
    const un = listen("approval-shortcut", () => {
      void approveWaitingNow();
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  // Global command palette shortcut: Cmd+K on macOS, Ctrl+K on Windows/Linux.
  // Registered in the CAPTURE phase and stopPropagation'd so the keystroke never
  // reaches the focused xterm (otherwise Ctrl+K would also fire bash's kill-line
  // inside the terminal, and the palette would feel unresponsive).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutRecording()) return;
      const isK = e.code === "KeyK" || e.key.toLowerCase() === "k";
      if ((e.metaKey || e.ctrlKey) && isK) {
        e.preventDefault();
        e.stopPropagation();
        togglePalette();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [togglePalette]);

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

  // Split-pane shortcuts (active SSH tab only), capture phase so the shell never
  // sees them: Ctrl+Shift+D split right · Ctrl+Shift+E split below ·
  // Ctrl+Shift+W close focused pane · Ctrl+Shift+←/→/↑/↓ focus move.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
      const tabs = useTabsStore.getState();
      const tab = tabs.tabs.find((t) => t.id === tabs.activeId);
      if (!tab || !["ssh", "local", "wsl"].includes(tab.kind)) return;

      const guard = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      if (e.code === "KeyD") {
        guard();
        void tabs.splitPane(tab.id, "col");
      } else if (e.code === "KeyE") {
        guard();
        void tabs.splitPane(tab.id, "row");
      } else if (e.code === "KeyW") {
        guard();
        const fid = tab.focusedPaneId ?? tab.panes?.[0]?.id;
        if (fid && (tab.panes?.length ?? 0) > 1) void tabs.closePane(tab.id, fid);
      } else if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown"
      ) {
        if (!tab.panes || tab.panes.length < 2) return;
        guard();
        const order = tab.panes.map((p) => p.id);
        const cur = order.indexOf(tab.focusedPaneId ?? order[0]);
        const next =
          e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? Math.max(0, cur - 1)
            : Math.min(order.length - 1, cur + 1);
        tabs.focusPane(tab.id, order[next]);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

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
                      onClick={() => setActive(tab.id)}
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
