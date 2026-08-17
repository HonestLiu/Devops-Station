import { useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  LayoutDashboard,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import { mqttConnections, dash } from "@/lib/api";
import type { MqttConnection, MqttProtocol } from "@/lib/types";
import { DashPage } from "./DashPage";

const PROTOCOLS: MqttProtocol[] = ["mqtt", "mqtts", "ws", "wss"];

function emptyConn(): MqttConnection {
  return {
    id: "",
    name: "",
    protocol: "mqtt",
    host: "localhost",
    port: 1883,
    clientId: "",
    username: undefined,
    password: undefined,
    savePassword: false,
    clean: true,
    keepAlive: 60,
    connectTimeout: 30,
    reconnect: true,
    path: "",
    insecureSkipVerify: false,
  };
}

export function MqttPage() {
  const t = useT();
  // null = the dashboard-style module picker (replaces the old side sub-nav).
  const [mode, setMode] = useState<"client" | "dash" | null>(null);
  const [connCount, setConnCount] = useState<number | null>(null);
  const [panelCount, setPanelCount] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    mqttConnections.list().then((l) => alive && setConnCount(l.length)).catch(() => alive && setConnCount(0));
    dash.list().then((l) => alive && setPanelCount(l.length)).catch(() => alive && setPanelCount(0));
    return () => {
      alive = false;
    };
  }, []);

  if (mode === null) {
    return <MqttModuleCards connCount={connCount} panelCount={panelCount} onPick={(m) => setMode(m)} />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb header (single row, NOT a tab bar — keeps the page from
          colliding with the app TabBar like the old top tabs did). */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <button
          onClick={() => setMode(null)}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-subtle transition-colors hover:bg-hover hover:text-fg"
          title={t("mqtt.modules")}
        >
          <ArrowLeft size={14} />
          {t("mqtt.modules")}
        </button>
        <span className="text-muted">/</span>
        <span className="text-[13px] font-semibold text-fg">
          {mode === "client" ? t("mqtt.title") : t("dash.title")}
        </span>
      </div>
      <div className="min-h-0 flex-1">{mode === "dash" ? <DashPage /> : <MqttClientView />}</div>
    </div>
  );
}

/**
 * Dashboard-style module picker: two big cards (MQTT Client / HMI Dashboard)
 * instead of the old text sub-nav. Clicking a card enters that module.
 */
function MqttModuleCards({
  connCount,
  panelCount,
  onPick,
}: {
  connCount: number | null;
  panelCount: number | null;
  onPick: (m: "client" | "dash") => void;
}) {
  const t = useT();
  const modules: {
    key: "client" | "dash";
    icon: React.ReactNode;
    title: string;
    desc: string;
    count: number | null;
    countLabel: string;
  }[] = [
    {
      key: "client",
      icon: <MessageSquare size={22} />,
      title: t("mqtt.title"),
      desc: t("mqtt.moduleDesc"),
      count: connCount,
      countLabel: t("mqtt.connections"),
    },
    {
      key: "dash",
      icon: <LayoutDashboard size={22} />,
      title: t("dash.title"),
      desc: t("dash.moduleDesc"),
      count: panelCount,
      countLabel: t("dash.panels"),
    },
  ];
  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-[18px] font-semibold text-fg">{t("mqtt.chooseModule")}</h1>
        <p className="mt-1 text-[13px] text-muted">{t("mqtt.chooseModuleDesc")}</p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {modules.map((m) => (
            <button
              key={m.key}
              onClick={() => onPick(m.key)}
              className="group flex flex-col rounded-xl border border-border/60 bg-bg p-5 text-left transition-all hover:border-accent/50 hover:shadow-md hover:shadow-accent/5"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent/15 text-accent transition-colors group-hover:bg-accent/25">
                {m.icon}
              </div>
              <div className="mt-3 text-[15px] font-semibold text-fg">{m.title}</div>
              <div className="mt-1 text-[12px] leading-relaxed text-muted">{m.desc}</div>
              <div className="mt-4 flex items-center gap-2">
                <span className="rounded-full bg-hover px-2.5 py-0.5 text-[11px] text-subtle">
                  {m.count ?? "·"} {m.countLabel}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MqttClientView() {
  const t = useT();
  const openMqtt = useTabsStore((s) => s.openMqtt);
  const [conns, setConns] = useState<MqttConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<MqttConnection | null>(null);
  const [showDialog, setShowDialog] = useState(false);

  const load = () => {
    setLoading(true);
    mqttConnections
      .list()
      .then((list) => {
        setConns(list);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, []);

  const onDelete = async (c: MqttConnection) => {
    if (!confirm(t("mqtt.confirmDelete"))) return;
    await mqttConnections.delete(c.id);
    load();
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-4">
        <MessageSquare size={16} className="text-accent" />
        <h1 className="text-[14px] font-semibold text-fg">{t("mqtt.title")}</h1>
        <div className="ml-auto">
          <Button variant="primary" size="sm" onClick={() => {
            setEditing(emptyConn());
            setShowDialog(true);
          }}>
            <Plus size={14} /> {t("mqtt.newConnection")}
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-muted">
            <Loader2 size={22} className="animate-spin" />
          </div>
        ) : conns.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-24 text-center text-muted">
            <Server size={28} />
            <p className="text-[13px]">{t("mqtt.noConnections")}</p>
            <Button variant="primary" size="sm" onClick={() => {
              setEditing(emptyConn());
              setShowDialog(true);
            }}>
              {t("mqtt.addFirst")}
            </Button>
          </div>
        ) : (
          <div className="mx-auto grid max-w-3xl gap-2">
            {conns.map((c) => (
              <div
                key={c.id}
                className="flex items-center gap-3 rounded-lg border border-border/60 bg-bg/40 px-3 py-2.5 transition-colors hover:border-accent/40"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-[12px] font-semibold text-accent">
                  {c.name.slice(0, 1).toUpperCase() || "M"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-fg">{c.name}</div>
                  <div className="truncate font-mono text-[11px] text-subtle">
                    {c.protocol}://{c.host}:{c.port}
                    {c.path ? c.path : ""}
                  </div>
                </div>
                <Button variant="primary" size="sm" onClick={() => void openMqtt(c)}>
                  {t("common.connect")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setEditing(c); setShowDialog(true); }}>
                  <Pencil size={14} />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void onDelete(c)}>
                  <Trash2 size={14} className="text-danger" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showDialog && editing && (
        <MqttConnectionDialog
          initial={editing}
          onClose={() => setShowDialog(false)}
          onSaved={() => {
            setShowDialog(false);
            load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection editor dialog
// ---------------------------------------------------------------------------

const inputCls =
  "w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent/60";
const labelCls = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-subtle";

function MqttConnectionDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: MqttConnection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState<MqttConnection>(initial);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const set = (patch: Partial<MqttConnection>) => setForm((f) => ({ ...f, ...patch }));
  const isWs = form.protocol === "ws" || form.protocol === "wss";
  const isTls = form.protocol === "mqtts" || form.protocol === "wss";

  const save = async () => {
    setSaving(true);
    setErr(undefined);
    try {
      const payload: MqttConnection = {
        ...form,
        // Never persist a password unless the user opted to save it.
        password: form.savePassword ? form.password || "" : "",
      };
      await mqttConnections.save(payload);
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="card w-[480px] max-w-full p-0 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border/70 px-5 py-3 text-[14px] font-semibold text-fg">
          {initial.id ? t("mqtt.editConnection") : t("mqtt.newConnection")}
        </div>

        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-5">
          <div>
            <label className={labelCls}>{t("mqtt.name")}</label>
            <input
              className={inputCls}
              value={form.name}
              placeholder="My Broker"
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-1">
              <label className={labelCls}>{t("mqtt.protocol")}</label>
              <select
                className={inputCls}
                value={form.protocol}
                onChange={(e) => set({ protocol: e.target.value as MqttProtocol })}
              >
                {PROTOCOLS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className={labelCls}>{t("mqtt.host")}</label>
              <input
                className={inputCls}
                value={form.host}
                placeholder="broker.emqx.io"
                onChange={(e) => set({ host: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{t("mqtt.port")}</label>
              <input
                type="number"
                className={inputCls}
                value={form.port}
                onChange={(e) => set({ port: Number(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className={labelCls}>{t("mqtt.clientId")}</label>
              <input
                className={inputCls}
                value={form.clientId}
                placeholder="(auto)"
                onChange={(e) => set({ clientId: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{t("mqtt.username")}</label>
              <input
                className={inputCls}
                value={form.username ?? ""}
                onChange={(e) => set({ username: e.target.value || undefined })}
              />
            </div>
            <div>
              <label className={labelCls}>{t("mqtt.password")}</label>
              <input
                type="password"
                className={inputCls}
                value={form.password ?? ""}
                placeholder={initial.id && !form.password ? "•••• (saved)" : ""}
                onChange={(e) => set({ password: e.target.value || undefined })}
              />
            </div>
          </div>

          {isWs && (
            <div>
              <label className={labelCls}>{t("mqtt.path")}</label>
              <input
                className={inputCls}
                value={form.path}
                placeholder="/mqtt"
                onChange={(e) => set({ path: e.target.value })}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{t("mqtt.keepAlive")}</label>
              <input
                type="number"
                className={inputCls}
                value={form.keepAlive}
                onChange={(e) => set({ keepAlive: Number(e.target.value) || 0 })}
              />
            </div>
            <div>
              <label className={labelCls}>{t("mqtt.connectTimeout")}</label>
              <input
                type="number"
                className={inputCls}
                value={form.connectTimeout}
                onChange={(e) => set({ connectTimeout: Number(e.target.value) || 0 })}
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input
              type="checkbox"
              checked={form.savePassword}
              onChange={(e) => set({ savePassword: e.target.checked })}
            />
            {t("mqtt.savePassword")}
          </label>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input
              type="checkbox"
              checked={form.clean}
              onChange={(e) => set({ clean: e.target.checked })}
            />
            {t("mqtt.cleanSession")}
          </label>
          <label className="flex items-center gap-2 text-[13px] text-fg">
            <input
              type="checkbox"
              checked={form.reconnect}
              onChange={(e) => set({ reconnect: e.target.checked })}
            />
            {t("mqtt.reconnect")}
          </label>
          {isTls && (
            <label className="flex items-center gap-2 text-[13px] text-fg">
              <input
                type="checkbox"
                checked={form.insecureSkipVerify}
                onChange={(e) => set({ insecureSkipVerify: e.target.checked })}
              />
              {t("mqtt.insecureSkipVerify")}
            </label>
          )}

          {err && (
            <div className="flex items-center gap-2 rounded-md bg-danger/10 px-3 py-2 text-[12px] text-danger">
              <AlertTriangle size={14} />
              {err}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border/70 px-5 py-3">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={save} disabled={saving || !form.name || !form.host}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
