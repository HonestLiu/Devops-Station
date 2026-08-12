import { useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import {
  Activity,
  Cable,
  FolderOpen,
  Globe,
  LayoutDashboard,
  MonitorSmartphone,
  Palette,
  Server,
  Settings as SettingsIcon,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

import { THEME_LIST } from "@/lib/themes";
import { cn, parseSshCommand } from "@/lib/utils";
import { isWindows } from "@/lib/platform";
import { useT } from "@/i18n";
import { useAppStore, type Page } from "@/store/useAppStore";
import { useHostsStore } from "@/store/useHostsStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useAiStore } from "@/ai/useAiStore";
import { explainSelection } from "@/ai/terminalAi";
import { analyzeTerminal, parseSerialProtocol, monitoringInsight } from "@/ai/tasks";
import { runAgent } from "@/ai/agent";

interface Cmd {
  id: string;
  label: string;
  group: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette() {
  const t = useT();
  const open = useAppStore((s) => s.paletteOpen);
  const togglePalette = useAppStore((s) => s.togglePalette);
  const setPage = useAppStore((s) => s.setPage);
  const updateSetting = useAppStore((s) => s.updateSetting);

  const hosts = useHostsStore((s) => s.hosts);
  const openFromHost = useTabsStore((s) => s.openFromHost);
  const openLocal = useTabsStore((s) => s.openLocal);
  const openSsh = useTabsStore((s) => s.openSsh);
  const openSerial = useTabsStore((s) => s.openSerial);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const close = () => togglePalette(false);

  const commands = useMemo<Cmd[]>(() => {
    const go = (page: Page) => () => {
      setPage(page);
      useTabsStore.getState().focusPage();
      close();
    };

    const list: Cmd[] = [
      {
        id: "nav-dashboard",
        label: t("palette.goDashboard"),
        group: t("palette.navigation"),
        icon: <LayoutDashboard size={15} />,
        run: go("dashboard"),
      },
      {
        id: "nav-hosts",
        label: t("palette.goHosts"),
        group: t("palette.navigation"),
        icon: <Server size={15} />,
        run: go("hosts"),
      },
      {
        id: "nav-monitoring",
        label: t("palette.goMonitoring"),
        group: t("palette.navigation"),
        icon: <Activity size={15} />,
        run: go("monitoring"),
      },
      {
        id: "nav-sftp",
        label: t("palette.goSftp"),
        group: t("palette.navigation"),
        icon: <FolderOpen size={15} />,
        run: go("sftp"),
      },
      {
        id: "nav-serial",
        label: t("palette.goSerial"),
        group: t("palette.navigation"),
        icon: <Cable size={15} />,
        run: go("serial"),
      },
      {
        id: "nav-settings",
        label: t("palette.goSettings"),
        group: t("palette.navigation"),
        icon: <SettingsIcon size={15} />,
        run: go("settings"),
      },
      {
        id: "conn-local",
        label: t("palette.openLocalShell"),
        group: t("palette.connections"),
        icon: <MonitorSmartphone size={15} />,
        run: () => {
          void openLocal();
          close();
        },
      },
      {
        id: "conn-ssh",
        label: t("palette.connectSsh"),
        group: t("palette.connections"),
        icon: <TerminalSquare size={15} />,
        run: () => {
          close();
          const target = window.prompt(t("palette.sshPrompt"));
          if (!target) return;
          const p = parseSshCommand(target);
          if (!p.valid) return;
          void openSsh(
            {
              hostname: p.hostname,
              port: p.port,
              username: p.username || "root",
              cols: 120,
              rows: 32,
              term: "xterm-256color",
            },
            p.username ? `${p.username}@${p.hostname}` : p.hostname,
          );
        },
      },
      {
        id: "conn-serial",
        label: t("palette.openSerialPort"),
        group: t("palette.connections"),
        icon: <Cable size={15} />,
        run: () => {
          close();
          const target = window.prompt(t("palette.serialPrompt"));
          if (!target) return;
          const port = target.trim();
          if (!port) return;
          void openSerial(
            {
              port,
              baudRate: 115200,
              dataBits: 8,
              stopBits: 1,
              parity: "none",
              flowControl: "none",
            },
            port,
          );
        },
      },
      {
        id: "ai-explain-selection",
        label: t("palette.explainSelected"),
        group: t("palette.ai"),
        icon: <Sparkles size={15} />,
        run: () => {
          close();
          void explainSelection();
        },
      },
      {
        id: "ai-generate-command",
        label: t("palette.generateCommand"),
        group: t("palette.ai"),
        icon: <Sparkles size={15} />,
        run: () => {
          close();
          useAiStore.getState().togglePanel(true);
        },
      },
      {
        id: "ai-analyze-log",
        label: t("palette.analyzeTerminalLog"),
        group: t("palette.ai"),
        icon: <Sparkles size={15} />,
        run: () => {
          close();
          analyzeTerminal();
        },
      },
      {
        id: "ai-parse-serial",
        label: t("palette.parseSerialProtocol"),
        group: t("palette.ai"),
        icon: <Sparkles size={15} />,
        run: () => {
          close();
          parseSerialProtocol();
        },
      },
      {
        id: "ai-monitor-insight",
        label: t("palette.monitoringInsight"),
        group: t("palette.ai"),
        icon: <Sparkles size={15} />,
        run: () => {
          close();
          const tabs = useTabsStore.getState().tabs;
          const ssh = tabs.find(
            (t) => t.kind === "ssh" && t.status === "connected" && t.sessionId,
          );
          void monitoringInsight(ssh?.sessionId);
        },
      },
      {
        id: "ai-run-agent",
        label: t("palette.runAgent"),
        group: t("palette.ai"),
        icon: <Sparkles size={15} />,
        run: () => {
          close();
          const goal = window.prompt(t("palette.agentGoal"));
          if (goal && goal.trim()) void runAgent(goal, false);
        },
      },
    ];

    for (const h of hosts) {
      // WSL hosts are Windows-only; skip them on macOS/Linux.
      if (h.kind === "wsl" && !isWindows) continue;
      list.push({
        id: `host-${h.id}`,
        label: t("palette.connectHost", { name: h.name }),
        group: t("palette.hosts"),
        hint: h.kind === "serial" ? h.serialPort ?? "" : h.kind === "wsl" ? h.wslDistro ?? "" : h.kind === "frp" ? t("palette.frpTunnel") : h.hostname ?? "",
        icon: h.kind === "serial" ? <Cable size={15} /> : h.kind === "wsl" ? <TerminalSquare size={15} /> : h.kind === "frp" ? <Globe size={15} /> : <Server size={15} />,
        run: () => {
          void (h.kind === "local" ? openLocal() : openFromHost(h));
          close();
        },
      });
    }

    for (const th of THEME_LIST) {
      list.push({
        id: `theme-${th.id}`,
        label: t("palette.theme", { label: th.label }),
        group: t("palette.appearance"),
        icon: <Palette size={15} />,
        run: () => {
          void updateSetting("theme", th.id);
          close();
        },
      });
    }

    return list;
  }, [hosts, openFromHost, openLocal, openSsh, setPage, togglePalette, updateSetting]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus after the portal paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const runAt = (i: number) => {
    const cmd = filtered[i];
    if (cmd) cmd.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  // Group rendering while preserving the flat index for keyboard nav.
  let flatIndex = -1;
  const groups = filtered.reduce<Record<string, Cmd[]>>((acc, c) => {
    (acc[c.group] ??= []).push(c);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={close} />
      <div className="relative w-full max-w-lg animate-scale-in overflow-hidden rounded-lg border border-border bg-elevated shadow-2xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("palette.typeToSearch")}
          className="select-text h-11 w-full border-b border-border bg-transparent px-4 text-[14px] text-fg placeholder:text-subtle focus:outline-none"
        />
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <p className="px-4 py-6 text-center text-[12px] text-subtle">No commands found.</p>
          )}
          {Object.entries(groups).map(([group, items]) => (
            <div key={group}>
              <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">
                {group}
              </div>
              {items.map((c) => {
                flatIndex += 1;
                const idx = flatIndex;
                const isActive = idx === active;
                return (
                  <button
                    key={c.id}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => runAt(idx)}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-2 text-left text-[13px]",
                      isActive ? "bg-accent/15 text-fg" : "text-muted hover:bg-hover",
                    )}
                  >
                    <span className="text-subtle">{c.icon}</span>
                    <span className="flex-1 truncate">{c.label}</span>
                    {c.hint && (
                      <span className="truncate font-mono text-[11px] text-subtle">
                        {c.hint}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
