import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  FileInput,
  FileOutput,
  LayoutDashboard,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Button, Dialog, EmptyState, Select } from "@/components/ui";
import { useT } from "@/i18n";
import { dash, mqttConnections } from "@/lib/api";
import type { DashPanel, MqttConnection } from "@/lib/types";
import { useTabsStore } from "@/store/useTabsStore";
import { useContextMenu, type MenuItem } from "@/store/useContextMenu";
import { cn } from "@/lib/utils";

const uid = () => Math.random().toString(36).slice(2, 10);

export function DashPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const [panels, setPanels] = useState<DashPanel[]>([]);
  const [conns, setConns] = useState<MqttConnection[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newConn, setNewConn] = useState("");
  const [editing, setEditing] = useState<DashPanel | null>(null);
  const [editName, setEditName] = useState("");
  const [editConn, setEditConn] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    dash.list().then(setPanels).catch(() => undefined);
    mqttConnections
      .list()
      .then((cs) => {
        setConns(cs);
        setNewConn((c) => c || cs[0]?.id || "");
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (!newName.trim() || !newConn) return;
    const p = await dash.save({
      id: "",
      name: newName.trim(),
      connectionId: newConn,
      connectionName: conns.find((c) => c.id === newConn)?.name ?? "",
      json: JSON.stringify({ cols: 12, widgets: [], background: { kind: "color", color: "#1a1b26" } }),
      sortOrder: panels.length,
      updatedAt: 0,
    });
    setShowNew(false);
    setNewName("");
    load();
    useTabsStore.getState().openMqttDashPanel(p);
  };

  // --- edit dialog (name + bound MQTT server, opened from the edit button or
  // the row's right-click menu) ----------------------------------------------
  const openEdit = (p: DashPanel) => {
    setEditing(p);
    setEditName(p.name);
    setEditConn(p.connectionId);
  };
  const saveEdit = async () => {
    if (!editing || !editName.trim()) return;
    await dash.save({
      ...editing,
      name: editName.trim(),
      connectionId: editConn,
      connectionName: conns.find((c) => c.id === editConn)?.name ?? "",
    });
    setEditing(null);
    load();
  };

  // Duplicate a panel (deep-copy its layout json, reset id/sortOrder).
  const duplicate = async (p: DashPanel) => {
    const np = await dash.save({
      id: "",
      name: `${p.name} 副本`,
      connectionId: p.connectionId,
      connectionName: p.connectionName,
      json: p.json,
      sortOrder: panels.length,
      updatedAt: 0,
    });
    load();
  };

  // Right-click menu on a panel row: reuses the same actions as the buttons.
  const panelMenu = (p: DashPanel, i: number): MenuItem[] => [
    { id: "edit", label: t("dash.ctx.edit"), icon: <Pencil size={14} />, onClick: () => openEdit(p) },
    { id: "open", label: t("dash.open"), icon: <Eye size={14} />, onClick: () => useTabsStore.getState().openMqttDashPanel(p) },
    { id: "duplicate", label: t("dash.ctx.duplicate"), icon: <Copy size={14} />, onClick: () => void duplicate(p) },
    { id: "export", label: t("dash.export"), icon: <FileOutput size={14} />, onClick: () => exportOne(p) },
    { id: "sep1", separator: true, label: "" },
    { id: "up", label: t("dash.moveUp"), icon: <ArrowUp size={14} />, disabled: i === 0, onClick: () => void move(i, -1) },
    { id: "down", label: t("dash.moveDown"), icon: <ArrowDown size={14} />, disabled: i === panels.length - 1, onClick: () => void move(i, 1) },
    { id: "sep2", separator: true, label: "" },
    { id: "delete", label: t("dash.delete"), icon: <Trash2 size={14} />, danger: true, onClick: () => void remove(p) },
  ];

  const remove = async (p: DashPanel) => {
    if (!confirm(t("dash.confirmDelete"))) return;
    await dash.delete(p.id);
    load();
  };

  const move = async (i: number, dir: -1 | 1) => {
    const next = [...panels];
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setPanels(next);
    await Promise.all(next.map((p, k) => dash.save({ ...p, sortOrder: k }).catch(() => undefined)));
  };

  const exportOne = (p: DashPanel) => {
    const blob = new Blob(
      [JSON.stringify({ name: p.name, connectionId: p.connectionId, connectionName: p.connectionName, json: p.json }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${p.name}.dash.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const j = JSON.parse(String(reader.result));
        const name = String(j.name ?? "导入面板").trim() || "导入面板";
        const connectionId = String(j.connectionId ?? conns[0]?.id ?? "");
        await dash.save({
          id: "",
          name,
          connectionId,
          connectionName: conns.find((c) => c.id === connectionId)?.name ?? "",
          json: typeof j.json === "string" ? j.json : JSON.stringify(j.json ?? { cols: 12, widgets: [], background: { kind: "color", color: "#1a1b26" } }),
          sortOrder: panels.length,
          updatedAt: 0,
        });
        load();
      } catch {
        /* invalid file */
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-4">
        <LayoutDashboard size={16} className="text-accent" />
        <h1 className="text-[14px] font-semibold text-fg">{t("dash.title")}</h1>
        <span className="text-[11px] text-subtle">{t("dash.subtitle")}</span>
        <div className="ml-auto flex items-center gap-1">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importFile(f);
              e.target.value = "";
            }}
          />
          <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>
            <FileInput size={14} /> {t("dash.import")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
            <Plus size={14} /> {t("dash.newPanel")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {panels.length === 0 ? (
          <EmptyState
            icon={<LayoutDashboard size={30} />}
            title={t("dash.noPanels")}
            description={t("dash.moduleDesc")}
            action={
              <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
                <Plus size={13} /> {t("dash.newPanel")}
              </Button>
            }
          />
        ) : (
          <div className="mx-auto grid max-w-5xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {panels.map((p, i) => {
              let widgetCount = 0;
              try {
                widgetCount = JSON.parse(p.json)?.widgets?.length ?? 0;
              } catch {
                /* ignore */
              }
              // Resolve the bound connection live from the loaded list (by id, the
              // real association) rather than trusting the persisted display name,
              // which can be blank if an autosave raced the connection load.
              const boundConn = conns.find((c) => c.id === p.connectionId);
              const hasConn = !!boundConn || (!!p.connectionId && p.connectionName !== "");
              const connLabel = boundConn?.name ?? p.connectionName ?? t("dash.noConnection");
              return (
                <div
                  key={p.id}
                  onClick={() => useTabsStore.getState().openMqttDashPanel(p)}
                  className="card card-interactive group relative flex cursor-pointer flex-col gap-3 p-3.5"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    useContextMenu.getState().show(e.clientX, e.clientY, panelMenu(p, i));
                  }}
                >
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/15 text-[15px] font-semibold text-accent">
                      {p.name.slice(0, 1).toUpperCase() || "D"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-fg">{p.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-subtle">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", hasConn ? "bg-accent" : "bg-subtle")} />
                        <span className="truncate">{connLabel}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="rounded-md bg-hover px-2 py-0.5 text-[10px] font-medium text-muted">
                      {widgetCount} {t("dash.widgets")}
                    </span>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); openEdit(p); }} title={t("dash.ctx.edit")}>
                        <Pencil size={13} />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); void duplicate(p); }} title={t("dash.duplicate")}>
                        <Copy size={13} />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); exportOne(p); }} title={t("dash.export")}>
                        <FileOutput size={13} />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); void remove(p); }} title={t("dash.delete")}>
                        <Trash2 size={13} className="text-danger" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
            <button
              onClick={() => setShowNew(true)}
              className="card card-interactive flex min-h-[88px] flex-col items-center justify-center gap-1 border-dashed text-subtle hover:text-accent"
            >
              <Plus size={18} />
              <span className="text-[12px] font-medium">{t("dash.newPanel")}</span>
            </button>
          </div>
        )}
      </div>

      <Dialog
        open={showNew}
        onClose={() => setShowNew(false)}
        title={t("dash.newPanel")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowNew(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={!newName.trim() || !newConn} onClick={() => void create()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-subtle">{t("dash.name")}</label>
            <input
              autoFocus
              className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent/60"
              value={newName}
              placeholder="我的客厅面板"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void create()}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-subtle">{t("dash.connection")}</label>
            <Select
              className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent/60"
              value={newConn}
              onChange={(e) => setNewConn(e.target.value)}
            >
              {conns.length === 0 && <option value="">{t("dash.noConnection")}</option>}
              {conns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.host}:{c.port})
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={t("dash.editPanel")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={!editName.trim()} onClick={() => void saveEdit()}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-subtle">{t("dash.name")}</label>
            <input
              autoFocus
              className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent/60"
              value={editName}
              placeholder="我的客厅面板"
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveEdit()}
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-subtle">{t("dash.connection")}</label>
            <Select
              className="w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent/60"
              value={editConn}
              onChange={(e) => setEditConn(e.target.value)}
            >
              {conns.length === 0 && <option value="">{t("dash.noConnection")}</option>}
              {conns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.protocol}://{c.host}:{c.port})
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
