import { useEffect } from "react";

import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { CommandPalette } from "./components/CommandPalette";

import { Dashboard } from "./pages/Dashboard";
import { Hosts } from "./pages/Hosts";
import { Monitoring } from "./pages/Monitoring";
import { Settings } from "./pages/Settings";

import { SshWorkspace } from "./components/workspace/SshWorkspace";
import { SerialWorkspace } from "./components/workspace/SerialWorkspace";
import { LocalWorkspace } from "./components/workspace/LocalWorkspace";
import { WslWorkspace } from "./components/workspace/WslWorkspace";
import { FrpWorkspace } from "./components/workspace/FrpWorkspace";
import { SftpWorkspace } from "./components/workspace/SftpWorkspace";
import { AiPanel } from "./ai/AiPanel";
import { useAiStore } from "./ai/useAiStore";

import { useAppStore, type Page } from "./store/useAppStore";
import { useTabsStore } from "./store/useTabsStore";
import { cn } from "./lib/utils";
import type { Tab } from "./lib/types";

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
  }
}

function TabContent({ tab }: { tab: Tab }) {
  if (tab.kind === "ssh") return <SshWorkspace tab={tab} />;
  if (tab.kind === "serial") return <SerialWorkspace tab={tab} />;
  if (tab.kind === "wsl") return <WslWorkspace tab={tab} />;
  if (tab.kind === "frp") return <FrpWorkspace tab={tab} />;
  if (tab.kind === "sftp") return <SftpWorkspace tab={tab} />;
  return <LocalWorkspace tab={tab} />;
}

export default function App() {
  const page = useAppStore((s) => s.page);
  const togglePalette = useAppStore((s) => s.togglePalette);

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

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-fg">
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
    </div>
  );
}
