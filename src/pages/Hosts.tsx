import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Cable,
  Globe,
  LogIn,
  MonitorSmartphone,
  Pencil,
  Plus,
  Search,
  Server,
  TerminalSquare,
  Trash2,
  Zap,
} from "lucide-react";

import { Badge, Button, EmptyState } from "@/components/ui";
import { HostDialog } from "@/components/HostDialog";
import { QuickCommandsEditor } from "@/components/QuickCommandsEditor";
import { parseSshCommand, hashColor } from "@/lib/utils";
import { isWindows } from "@/lib/platform";
import { useHostsStore, emptyHost } from "@/store/useHostsStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useContextMenu, type MenuItem } from "@/store/useContextMenu";
import type { Host, HostKind } from "@/lib/types";

const KIND_ICON = {
  ssh: Server,
  serial: Cable,
  wsl: TerminalSquare,
  frp: Globe,
  local: MonitorSmartphone,
} as const;

const KIND_LABEL: Record<HostKind, string> = {
  ssh: "SSH",
  serial: "Serial",
  wsl: "WSL",
  frp: "Frp",
  local: "Local",
};

export function Hosts() {
  const hosts = useHostsStore((s) => s.hosts);
  const deleteHost = useHostsStore((s) => s.deleteHost);
  const openFromHost = useTabsStore((s) => s.openFromHost);
  const openLocal = useTabsStore((s) => s.openLocal);

  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState("");
  const [editing, setEditing] = useState<Host | null>(null);
  const [creating, setCreating] = useState(false);
  const [qcOpen, setQcOpen] = useState(false);

  const filtered = useMemo(() => {
    // Serial devices now live on their own sidebar page, so keep them out of
    // the combined Hosts grid. WSL hosts are Windows-only, so also drop them
    // on macOS/Linux (a profile imported from Windows may contain them).
    const nonSerial = hosts.filter(
      (h) => h.kind !== "serial" && (isWindows || h.kind !== "wsl"),
    );
    const q = query.trim().toLowerCase();
    if (!q) return nonSerial;
    return nonSerial.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        (h.hostname ?? "").toLowerCase().includes(q) ||
        (h.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }, [hosts, query]);

  const connect = (h: Host) => {
    if (h.kind === "local") void openLocal();
    else void openFromHost(h);
  };

  const showCtx = useContextMenu((s) => s.show);
  const closeCtx = useContextMenu((s) => s.close);

  const onHostContextMenu = (e: ReactMouseEvent, h: Host) => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      {
        id: "connect",
        label: "连接",
        icon: <LogIn size={14} />,
        onClick: () => {
          closeCtx();
          connect(h);
        },
      },
      {
        id: "edit",
        label: "编辑",
        icon: <Pencil size={14} />,
        onClick: () => {
          closeCtx();
          setEditing(h);
        },
      },
      { id: "sep", separator: true, label: "" },
      {
        id: "delete",
        label: "删除",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => {
          closeCtx();
          if (window.confirm(`Delete host "${h.name}"?`)) void deleteHost(h.id);
        },
      },
    ];
    showCtx(e.clientX, e.clientY, items);
  };

  const quickConnect = () => {
    const p = parseSshCommand(quick);
    if (!p.valid) return;
    void openFromHost({
      ...emptyHost("ssh"),
      hostname: p.hostname,
      port: p.port,
      username: p.username || "root",
    } as Host);
    setQuick("");
  };

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Hosts</h1>
          <p className="page-subtitle">Saved SSH, WSL and Frp targets</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setQcOpen(true)}>
            <Zap size={14} /> Quick Commands
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> New Host
          </Button>
        </div>
      </div>

      {/* Quick connect */}
      <div className="mb-4 flex items-center gap-2 rounded-xl border border-border/80 bg-surface px-2 py-1.5">
        <span className="icon-chip h-7 w-7">
          <TerminalSquare size={13} />
        </span>
        <input
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && quickConnect()}
          placeholder="Quick connect: ssh user@host or host:port"
          className="select-text h-8 flex-1 bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none"
        />
        <Button variant="ghost" size="sm" onClick={quickConnect}>
          Connect
        </Button>
      </div>

      {/* Search */}
      <div className="relative mb-4 max-w-sm">
        <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter hosts…"
          className="select-text h-9 w-full rounded-xl border border-border/80 bg-surface pl-9 pr-3 text-[13px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
        />
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Server size={28} />}
          title={hosts.length === 0 ? "No hosts yet" : "No matches"}
          description={
            hosts.length === 0
              ? "Add a host to start managing SSH, local, and Frp connections."
              : "Try a different search term."
          }
          action={
            hosts.length === 0 ? (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus size={14} /> New Host
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((h) => {
            const Icon = KIND_ICON[h.kind];
            const color = h.color || hashColor(h.name);
            const subtitle =
              h.kind === "serial"
                ? `${h.serialPort ?? "?"} · ${h.baudRate ?? 115200} baud`
                : h.kind === "local"
                  ? "this machine"
              : h.kind === "wsl"
                ? `WSL · ${h.wslDistro || "default"}`
                : h.kind === "frp"
                  ? `Frp · ${h.frpConfig ? "configured" : "unconfigured"}`
                  : `${h.username ? h.username + "@" : ""}${h.hostname ?? "?"}${h.port ? ":" + h.port : ""}`;
            return (
              <div
                key={h.id}
                className="card card-interactive group flex flex-col"
                onContextMenu={(e) => onHostContextMenu(e, h)}
              >
                <div className="mb-3 flex items-center gap-2.5">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold text-accent-fg"
                    style={{ backgroundColor: color }}
                  >
                    {h.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
                    {h.name}
                  </span>
                  <Badge tone={h.kind === "serial" ? "warning" : "accent"}>
                    {KIND_LABEL[h.kind]}
                  </Badge>
                </div>
                <div className="mb-3 flex items-center gap-1.5 text-[12px] text-muted">
                  <Icon size={13} className="shrink-0 text-subtle" />
                  <span className="truncate">{subtitle}</span>
                </div>

                {h.tags && h.tags.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1">
                    {h.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-hover px-2 py-0.5 text-[10px] text-subtle"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-auto flex items-center gap-1.5">
                  <Button variant="primary" size="sm" className="flex-1" onClick={() => connect(h)}>
                    Connect
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(h)} title="Edit">
                    <Pencil size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      if (window.confirm(`Delete host "${h.name}"?`)) void deleteHost(h.id);
                    }}
                    title="Delete"
                  >
                    <Trash2 size={13} className="text-danger" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <HostDialog
          initial={emptyHost("ssh")}
          onClose={() => setCreating(false)}
          onSaved={() => setCreating(false)}
        />
      )}
      {editing && (
        <HostDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
      {qcOpen && <QuickCommandsEditor onClose={() => setQcOpen(false)} />}
    </div>
  );
}
