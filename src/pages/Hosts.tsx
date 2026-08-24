import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Cable,
  ChevronDown,
  ChevronRight,
  FolderTree,
  Globe,
  LayoutGrid,
  List as ListIcon,
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
import { DistroIcon } from "@/components/DistroIcon";
import { parseSshCommand, hashColor, cn } from "@/lib/utils";
import { isWindows } from "@/lib/platform";
import { useT, type TKey } from "@/i18n";
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

const KIND_LABEL: Record<HostKind, TKey> = {
  ssh: "hosts.kindSsh",
  serial: "hosts.kindSerial",
  wsl: "hosts.kindWsl",
  frp: "hosts.kindFrp",
  local: "hosts.kindLocal",
};

type HostView = "grid" | "list" | "tree";

const UNGROUPED = "__ungrouped__";

function hostSubtitle(h: Host, t: (k: TKey, p?: Record<string, string | number>) => string): string {
  if (h.kind === "serial")
    return t("hosts.baud", { port: h.serialPort ?? "?", baud: h.baudRate ?? 115200 });
  if (h.kind === "local") return t("hosts.thisMachine");
  if (h.kind === "wsl") return t("hosts.wslDistro", { distro: h.wslDistro || "default" });
  if (h.kind === "frp")
    return h.frpConfig ? t("hosts.frpConfigured") : t("hosts.frpUnconfigured");
  return `${h.username ? h.username + "@" : ""}${h.hostname ?? "?"}${h.port ? ":" + h.port : ""}`;
}

/** Shared compact row used by the List and Tree views. */
function HostRow({
  h,
  onConnect,
  onEdit,
  onDelete,
  onOpenTerminal,
  onContextMenu,
}: {
  h: Host;
  onConnect: (h: Host) => void;
  onEdit: (h: Host) => void;
  onDelete: (h: Host) => void;
  onOpenTerminal: (h: Host) => void;
  onContextMenu: (e: ReactMouseEvent, h: Host) => void;
}) {
  const t = useT();
  const Icon = KIND_ICON[h.kind];
  const color = h.color || hashColor(h.name);
  return (
    <div
      className="group flex items-center gap-3 rounded-xl border border-border/70 bg-surface px-3 py-2 transition-colors hover:border-accent/40"
      onContextMenu={(e) => onContextMenu(e, h)}
    >
      <span
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold text-accent-fg"
        style={{ backgroundColor: color }}
      >
        {h.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-fg">{h.name}</span>
          <Badge tone={h.kind === "serial" ? "warning" : "accent"}>{t(KIND_LABEL[h.kind])}</Badge>
          <DistroIcon distro={h.distro} size={18} />
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <Icon size={12} className="shrink-0 text-subtle" />
          <span className="truncate">{hostSubtitle(h, t)}</span>
        </div>
      </div>
      {h.tags && h.tags.length > 0 && (
        <div className="hidden flex-wrap gap-1 md:flex">
          {h.tags.slice(0, 3).map((tg) => (
            <span key={tg} className="rounded-full bg-hover px-2 py-0.5 text-[10px] text-subtle">
              {tg}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={() => onConnect(h)} title={t("common.connect")}>
          <LogIn size={13} />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onEdit(h)} title={t("common.edit")}>
          <Pencil size={13} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpenTerminal(h)}
          title={t("hosts.openTerminal")}
        >
          <TerminalSquare size={13} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onDelete(h)}
          title={t("common.delete")}
        >
          <Trash2 size={13} className="text-danger" />
        </Button>
      </div>
    </div>
  );
}

export function Hosts() {
  const t = useT();
  const hosts = useHostsStore((s) => s.hosts);
  const deleteHost = useHostsStore((s) => s.deleteHost);
  const openFromHost = useTabsStore((s) => s.openFromHost);
  const openLocal = useTabsStore((s) => s.openLocal);

  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState("");
  const [editing, setEditing] = useState<Host | null>(null);
  const [creating, setCreating] = useState(false);
  const [qcOpen, setQcOpen] = useState(false);
  const [view, setView] = useState<HostView>("grid");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  // Tree grouping by the host's first tag; untagged hosts fall under "Ungrouped".
  const grouped = useMemo(() => {
    const map = new Map<string, Host[]>();
    for (const h of filtered) {
      const g = h.tags && h.tags.length ? h.tags[0] : UNGROUPED;
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(h);
    }
    return [...map.entries()].sort(
      (a, b) =>
        (a[0] === UNGROUPED ? 1 : 0) - (b[0] === UNGROUPED ? 1 : 0) ||
        a[0].localeCompare(b[0]),
    );
  }, [filtered]);

  const connect = (h: Host) => {
    if (h.kind === "local") void openLocal();
    else void openFromHost(h);
  };

  const openTerminal = () => void openLocal();

  const deleteWithConfirm = (h: Host) => {
    if (window.confirm(t("hosts.deleteConfirm", { name: h.name }))) void deleteHost(h.id);
  };

  const showCtx = useContextMenu((s) => s.show);
  const closeCtx = useContextMenu((s) => s.close);

  const onHostContextMenu = (e: ReactMouseEvent, h: Host) => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      {
        id: "connect",
        label: t("common.connect"),
        icon: <LogIn size={14} />,
        onClick: () => {
          closeCtx();
          connect(h);
        },
      },
      {
        id: "edit",
        label: t("common.edit"),
        icon: <Pencil size={14} />,
        onClick: () => {
          closeCtx();
          setEditing(h);
        },
      },
      {
        id: "openTerminal",
        label: t("hosts.openTerminal"),
        icon: <TerminalSquare size={14} />,
        onClick: () => {
          closeCtx();
          openTerminal();
        },
      },
      { id: "sep", separator: true, label: "" },
      {
        id: "delete",
        label: t("common.delete"),
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => {
          closeCtx();
          deleteWithConfirm(h);
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

  const toggleGroup = (g: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  };

  const ViewButton = ({ id, icon: Icon, label }: { id: HostView; icon: typeof LayoutGrid; label: string }) => (
    <button
      onClick={() => setView(id)}
      title={label}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors",
        view === id ? "bg-accent/15 text-accent" : "text-subtle hover:bg-hover hover:text-fg",
      )}
    >
      <Icon size={15} />
    </button>
  );

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">{t("hosts.title")}</h1>
          <p className="page-subtitle">{t("hosts.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setQcOpen(true)}>
            <Zap size={14} /> {t("hosts.quickCommands")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} /> {t("hosts.newHost")}
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
          placeholder={t("hosts.quickConnectPlaceholder")}
          className="select-text h-8 flex-1 bg-transparent text-[13px] text-fg placeholder:text-subtle focus:outline-none"
        />
        <Button variant="ghost" size="sm" onClick={quickConnect}>
          {t("common.connect")}
        </Button>
      </div>

      {/* Search + view switcher */}
      <div className="mb-4 flex items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("hosts.filterPlaceholder")}
            className="select-text h-9 w-full rounded-xl border border-border/80 bg-surface pl-9 pr-3 text-[13px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-xl border border-border/80 bg-surface p-1">
          <ViewButton id="grid" icon={LayoutGrid} label={t("hosts.viewGrid")} />
          <ViewButton id="list" icon={ListIcon} label={t("hosts.viewList")} />
          <ViewButton id="tree" icon={FolderTree} label={t("hosts.viewTree")} />
        </div>
      </div>

      {/* Body */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Server size={28} />}
          title={hosts.length === 0 ? t("hosts.emptyTitle") : t("hosts.noMatches")}
          description={hosts.length === 0 ? t("hosts.emptyHint") : t("hosts.noMatchesHint")}
          action={
            hosts.length === 0 ? (
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus size={14} /> {t("hosts.newHost")}
              </Button>
            ) : undefined
          }
        />
      ) : view === "grid" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((h) => {
            const Icon = KIND_ICON[h.kind];
            const color = h.color || hashColor(h.name);
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
                    {t(KIND_LABEL[h.kind])}
                  </Badge>
                  <DistroIcon distro={h.distro} size={18} />
                </div>
                <div className="mb-3 flex items-center gap-1.5 text-[12px] text-muted">
                  <Icon size={13} className="shrink-0 text-subtle" />
                  <span className="truncate">{hostSubtitle(h, t)}</span>
                </div>

                {h.tags && h.tags.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-1">
                    {h.tags.map((tg) => (
                      <span
                        key={tg}
                        className="rounded-full bg-hover px-2 py-0.5 text-[10px] text-subtle"
                      >
                        {tg}
                      </span>
                    ))}
                  </div>
                )}

                <div className="mt-auto flex items-center gap-1.5">
                  <Button variant="primary" size="sm" className="flex-1" onClick={() => connect(h)}>
                    {t("common.connect")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(h)} title={t("common.edit")}>
                    <Pencil size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openTerminal()}
                    title={t("hosts.openTerminal")}
                  >
                    <TerminalSquare size={13} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteWithConfirm(h)}
                    title={t("common.delete")}
                  >
                    <Trash2 size={13} className="text-danger" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : view === "list" ? (
        <div className="flex flex-col gap-2">
          {filtered.map((h) => (
            <HostRow
              key={h.id}
              h={h}
              onConnect={connect}
              onEdit={setEditing}
              onDelete={deleteWithConfirm}
              onOpenTerminal={openTerminal}
              onContextMenu={onHostContextMenu}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map(([group, items]) => {
            const isCollapsed = collapsed.has(group);
            const label = group === UNGROUPED ? t("hosts.ungrouped") : group;
            return (
              <div key={group}>
                <button
                  onClick={() => toggleGroup(group)}
                  className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-[12px] font-semibold text-muted transition-colors hover:text-fg"
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span>{label}</span>
                  <span className="rounded-full bg-hover px-1.5 text-[10px] text-subtle">
                    {items.length}
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="mt-1 flex flex-col gap-2">
                    {items.map((h) => (
                      <HostRow
                        key={h.id}
                        h={h}
                        onConnect={connect}
                        onEdit={setEditing}
                        onDelete={deleteWithConfirm}
                        onOpenTerminal={openTerminal}
                        onContextMenu={onHostContextMenu}
                      />
                    ))}
                  </div>
                )}
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
