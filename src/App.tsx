import { useEffect, type MouseEvent as ReactMouseEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Cable,
  Copy,
  FolderOpen,
  Microchip,
  MonitorSmartphone,
  Server,
  Settings as SettingsIcon,
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

import { SshWorkspace } from "./components/workspace/SshWorkspace";
import { SerialWorkspace } from "./components/workspace/SerialWorkspace";
import { LocalWorkspace } from "./components/workspace/LocalWorkspace";
import { WslWorkspace } from "./components/workspace/WslWorkspace";
import { FrpWorkspace } from "./components/workspace/FrpWorkspace";
import { SftpWorkspace } from "./components/workspace/SftpWorkspace";
import { JLinkWorkspace } from "./components/workspace/JLinkWorkspace";
import { AiPanel } from "./ai/AiPanel";
import { useAiStore } from "./ai/useAiStore";

import { useAppStore, type Page } from "./store/useAppStore";
import { useTabsStore } from "./store/useTabsStore";
import { usePermStore } from "./store/usePermStore";
import { useContextMenu, type MenuItem } from "./store/useContextMenu";
import { useT } from "./i18n";
import { cn } from "./lib/utils";
import { approveWaitingNow } from "./lib/quickApprove";
import { matchesShortcut } from "./lib/shortcut";
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
  }
}

function TabContent({ tab }: { tab: Tab }) {
  if (tab.kind === "ssh") return <SshWorkspace tab={tab} />;
  if (tab.kind === "serial" || tab.kind === "ble") return <SerialWorkspace tab={tab} />;
  if (tab.kind === "wsl") return <WslWorkspace tab={tab} />;
  if (tab.kind === "frp") return <FrpWorkspace tab={tab} />;
  if (tab.kind === "sftp") return <SftpWorkspace tab={tab} />;
  if (tab.kind === "jlink") return <JLinkWorkspace tab={tab} />;
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
  // (except text fields, which keep cut/copy/paste) and show our own menu.
  const onRootContextMenu = (e: ReactMouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')
    ) {
      return;
    }
    e.preventDefault();
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
  const activeTab = tabs.find((t) => t.id === activeId);

  const showTabs = tabs.length > 0;

  // Toggle the AI panel with Cmd+. (macOS) / Ctrl+. (Windows/Linux), capture phase
  // so it wins over the terminal.
  const toggleAi = useAiStore((s) => s.togglePanel);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

  // Quick approval shortcut (configurable in Settings → Shortcuts): sends Enter
  // to the session that is currently waiting on an agent CLI approval prompt
  // (Claude Code, Codex, …), confirming the highlighted "Yes" option without
  // leaving the current view. Capture phase + stopPropagation so the keystroke
  // never reaches the terminal.
  const approveShortcut = useAppStore((s) => s.settings.approveShortcut);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesShortcut(e, approveShortcut)) {
        e.preventDefault();
        e.stopPropagation();
        void approveWaitingNow();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [approveShortcut]);

  // Global command palette shortcut: Cmd+K on macOS, Ctrl+K on Windows/Linux.
  // Registered in the CAPTURE phase and stopPropagation'd so the keystroke never
  // reaches the focused xterm (otherwise Ctrl+K would also fire bash's kill-line
  // inside the terminal, and the palette would feel unresponsive).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
            Every open tab stays mounted. Rendering only the active one would
            tear down its xterm instance on each switch, taking the scrollback,
            the running session view and the SFTP listing with it — you'd come
            back to a blank terminal.

            `invisible` rather than `hidden`: visibility:hidden keeps layout, so
            FitAddon can still measure the element and the terminal is already
            the right size the moment you switch back.
          */}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={cn(
                "absolute inset-0",
                tab.id === activeId ? "z-10" : "invisible pointer-events-none",
              )}
              aria-hidden={tab.id !== activeId}
            >
              <TabContent tab={tab} />
            </div>
          ))}
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
    </div>
  );
}
