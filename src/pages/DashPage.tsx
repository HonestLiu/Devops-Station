import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Download,
  LayoutDashboard,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui";
import { useT } from "@/i18n";
import { dash, mqttConnections } from "@/lib/api";
import type { DashPanel, MqttConnection } from "@/lib/types";
import { DashBoard } from "@/dash/DashBoard";
import { cn } from "@/lib/utils";

const uid = () => Math.random().toString(36).slice(2, 10);

export function DashPage() {
  const t = useT();
  const [panels, setPanels] = useState<DashPanel[]>([]);
  const [conns, setConns] = useState<MqttConnection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newConn, setNewConn] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");
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

  const active = panels.find((p) => p.id === activeId) ?? null;

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
    setActiveId(p.id);
    load();
  };

  const rename = async (id: string) => {
    const p = panels.find((x) => x.id === id);
    if (!p || !renameVal.trim()) return;
    await dash.save({ ...p, name: renameVal.trim() });
    setRenaming(null);
    load();
  };

  const remove = async (p: DashPanel) => {
    if (!confirm(t("dash.confirmDelete"))) return;
    await dash.delete(p.id);
    if (activeId === p.id) setActiveId(null);
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

  if (active) {
    return (
      <DashBoard
        panel={active}
        onBack={() => {
          setActiveId(null);
          load();
        }}
        onSaved={(p) => setPanels((ps) => ps.map((x) => (x.id === p.id ? p : x)))}
      />
    );
  }

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
            <Upload size={14} /> {t("dash.import")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
            <Plus size={14} /> {t("dash.newPanel")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {panels.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-24 text-center text-muted">
            <LayoutDashboard size={30} />
            <p className="text-[13px]">{t("dash.noPanels")}</p>
            <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
              <Plus size={13} /> {t("dash.newPanel")}
            </Button>
          </div>
        ) : (
          <div className="mx-auto grid max-w-3xl gap-2">
            {panels.map((p, i) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-bg/40 px-3 py-2.5 transition-colors hover:border-accent/40"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-[13px] font-semibold text-accent">
                  {p.name.slice(0, 1).toUpperCase() || "D"}
                </span>
                <div className="min-w-0 flex-1">
                  {renaming === p.id ? (
                    <input
                      autoFocus
                      value={renameVal}
                      onChange={(e) => setRenameVal(e.target.value)}
                      onBlur={() => void rename(p.id)}
                      onKeyDown={(e) => e.key === "Enter" && void rename(p.id)}
                      className="w-full max-w-[220px] rounded border border-accent/60 bg-bg px-2 py-0.5 text-[13px] text-fg outline-none"
                    />
                  ) : (
                    <div className="truncate text-[13px] font-medium text-fg">{p.name}</div>
                  )}
                  <div className="truncate text-[11px] text-subtle">
                    {p.connectionName || t("dash.noConnection")}
                    {" · "}
                    {(() => {
                      try {
                        const j = JSON.parse(p.json);
                        return `${j.widgets?.length ?? 0} ${t("dash.widgets")}`;
                      } catch {
                        return `0 ${t("dash.widgets")}`;
                      }
                    })()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button variant="ghost" size="sm" disabled={i === 0} onClick={() => void move(i, -1)} title={t("dash.moveUp")}>
                    <ArrowUp size={13} />
                  </Button>
                  <Button variant="ghost" size="sm" disabled={i === panels.length - 1} onClick={() => void move(i, 1)} title={t("dash.moveDown")}>
                    <ArrowDown size={13} />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setRenaming(p.id); setRenameVal(p.name); }} title={t("dash.rename")}>
                    <Pencil size={13} />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => exportOne(p)} title={t("dash.export")}>
                    <Download size={13} />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void remove(p)} title={t("dash.delete")}>
                    <Trash2 size={13} className="text-danger" />
                  </Button>
                  <Button variant="primary" size="sm" className="ml-1" onClick={() => setActiveId(p.id)}>
                    {t("dash.open")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showNew && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowNew(false)}>
          <div className="card w-[380px] max-w-full p-0 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-border/70 px-5 py-3 text-[14px] font-semibold text-fg">{t("dash.newPanel")}</div>
            <div className="space-y-3 p-5">
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
                <select
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
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-border/70 px-5 py-3">
              <Button variant="secondary" onClick={() => setShowNew(false)}>
                {t("common.cancel")}
              </Button>
              <Button variant="primary" disabled={!newName.trim() || !newConn} onClick={() => void create()}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
