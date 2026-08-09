import { useMemo, useState } from "react";
import {
  Cable,
  Globe,
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
import { useHostsStore, emptyHost } from "@/store/useHostsStore";
import { useTabsStore } from "@/store/useTabsStore";
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
    const q = query.trim().toLowerCase();
    if (!q) return hosts;
    return hosts.filter(
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
    <div className="h-full overflow-y-auto p-5">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[18px] font-semibold text-fg">Hosts</h1>
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
      <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <TerminalSquare size={15} className="ml-1 text-subtle" />
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
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter hosts…"
          className="select-text h-8 w-full rounded border border-border bg-surface pl-8 pr-3 text-[13px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
        />
      </div>

      {/* Grid */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Server size={28} />}
          title={hosts.length === 0 ? "No hosts yet" : "No matches"}
          description={
            hosts.length === 0
              ? "Add a host to start managing SSH, serial, local, and Frp connections."
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
                className="group flex flex-col rounded-lg border border-border bg-elevated p-3 hover:border-accent/50"
              >
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: h.color || hashColor(h.name) }}
                  />
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
                        className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-subtle"
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
