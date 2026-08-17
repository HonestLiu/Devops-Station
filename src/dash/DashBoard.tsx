import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft,
  Download,
  Eye,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Paintbrush,
  Pencil,
  PencilRuler,
  Play,
  Plus,
  Save,
  Settings2,
  Trash2,
  Upload,
  Wand2,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { Button, SideIconButton } from "@/components/ui";
import { useT } from "@/i18n";
import { dash, mqtt, mqttConnections } from "@/lib/api";
import type { DashPanel, DashPanelJson, DashWidget, MqttMessage } from "@/lib/types";
import { CATEGORY_KEYS, WIDGETS, widgetMeta } from "./registry";
import { runParse, runPublish, base64ToUtf8, utf8ToBase64, topicCovered } from "./exec";
import { WidgetRenderer, widgetIcon, type DashLogEntry } from "./WidgetRenderer";
import { MiniEditor } from "./miniEditor";
import { aiGenerateParse, hasAiConfig } from "./ai";
import { cn } from "@/lib/utils";

const COLS = 12;
const ROW_H = 72;
const MAX_H = 60;
const uid = () => Math.random().toString(36).slice(2, 10);

function parsePanel(s: string): DashPanelJson {
  try {
    const j = JSON.parse(s);
    return {
      cols: j.cols ?? COLS,
      widgets: Array.isArray(j.widgets) ? j.widgets : [],
      background: j.background ?? { kind: "color", color: "#1a1b26" },
    };
  } catch {
    return { cols: COLS, widgets: [], background: { kind: "color", color: "#1a1b26" } };
  }
}

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

export function DashBoard({
  panel,
  onBack,
  onSaved,
}: {
  panel: DashPanel;
  onBack: () => void;
  onSaved: (p: DashPanel) => void;
}) {
  const t = useT();
  const [json, setJson] = useState<DashPanelJson>(() => parsePanel(panel.json));
  const widgets = json.widgets;
  const [name, setName] = useState(panel.name);
  const [editMode, setEditMode] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showLib, setShowLib] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connStatus, setConnStatus] = useState<"connecting" | "connected" | "error" | "off">("off");
  const [connError, setConnError] = useState("");
  const [runtimes, setRuntimes] = useState<Record<string, { raw: string; rawAt: number; values: Record<string, unknown>; parseError?: string }>>({});
  const [log, setLog] = useState<DashLogEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [histTick, setHistTick] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>(0);
  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };
  const historyRef = useRef<Record<string, Record<string, number>[]>>({});
  const widgetsRef = useRef(widgets);
  widgetsRef.current = widgets;
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; mode: "move" | "resize"; sx: number; sy: number; ow: DashWidget; colW: number } | null>(null);

  const setWidgets = (updater: (ws: DashWidget[]) => DashWidget[]) =>
    setJson((j) => ({ ...j, widgets: updater(j.widgets) }));

  // --- MQTT session (connect once; resubscribe on widget topics change) ------
  useEffect(() => {
    let disposed = false;
    let sid: string | null = null;
    let unMsg: (() => void) | undefined;
    let unSt: (() => void) | undefined;

    const subscribeAll = async () => {
      if (!sid) return;
      const seen = new Set<string>();
      for (const w of widgetsRef.current) {
        for (const tp of w.topics) {
          if (!tp.trim() || seen.has(tp.trim())) continue;
          seen.add(tp.trim());
          await mqtt.subscribe(sid, tp.trim(), 0, null).catch(() => undefined);
        }
      }
    };

    const onMsg = (m: MqttMessage) => {
      if (m.direction !== "in") return;
      const text = base64ToUtf8(m.payloadBase64);
      setLog((l) => [...l.slice(-499), { id: m.id, ts: m.timestamp, topic: m.topic, payload: text.slice(0, 400), dir: "in" }]);
      for (const w of widgetsRef.current) {
        if (!topicCovered(m.topic, w.topics)) continue;
        const meta = widgetMeta(w.type);
        const res = meta ? runParse(w.parseFn, text, m.topic) : null;
        if (res?.ok) {
          setRuntimes((rt) => ({ ...rt, [w.id]: { raw: text, rawAt: m.timestamp, values: res.out } }));
          if (w.type === "lineChart" || w.type === "barChart") {
            const s = (res.out.series ?? res.out.values) as Record<string, number> | undefined;
            if (s && typeof s === "object" && !Array.isArray(s)) {
              const max = Number(w.config.maxPoints ?? 60) || 60;
              historyRef.current[w.id] = [...(historyRef.current[w.id] ?? []).slice(-(max - 1)), s];
              setHistTick((x) => x + 1);
            }
          }
        } else {
          setRuntimes((rt) => ({
            ...rt,
            [w.id]: { raw: text, rawAt: m.timestamp, values: rt[w.id]?.values ?? {}, parseError: res ? res.error : undefined },
          }));
        }
      }
    };

    (async () => {
      if (!panel.connectionId) {
        setConnStatus("off");
        return;
      }
      setConnStatus("connecting");
      try {
        const conns = await mqttConnections.list(true);
        const conn = conns.find((c) => c.id === panel.connectionId);
        if (!conn || disposed) {
          setConnStatus("off");
          return;
        }
        sid = await mqtt.connect({
          name: conn.name,
          protocol: conn.protocol,
          host: conn.host,
          port: conn.port,
          clientId: conn.clientId,
          username: conn.username,
          password: conn.password || (conn.savePassword ? "__saved__" : ""),
          hostId: conn.id,
          clean: conn.clean,
          keepAlive: conn.keepAlive,
          connectTimeout: conn.connectTimeout,
          reconnect: conn.reconnect,
          path: conn.path,
          insecureSkipVerify: conn.insecureSkipVerify,
        });
        if (disposed) {
          void mqtt.disconnect(sid);
          return;
        }
        setSessionId(sid);
        unMsg = (await mqtt.onMessage(sid, onMsg)) as unknown as () => void;
        unSt = (await mqtt.onStatus(sid, (s) => setConnStatus(s.status === "connected" ? "connected" : s.status === "error" ? "error" : "connecting"))) as unknown as () => void;
        setConnStatus("connected");
        void subscribeAll();
      } catch (e) {
        if (!disposed) {
          setConnStatus("error");
          setConnError((e as Error).message);
        }
      }
    })();

    return () => {
      disposed = true;
      unMsg?.();
      unSt?.();
      if (sid) void mqtt.disconnect(sid);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resubscribe when the widget topic set grows (initial connect is in effect 1).
  const topicSig = widgets.flatMap((w) => w.topics).join("\n");
  useEffect(() => {
    if (connStatus !== "connected" || !sessionId) return;
    const seen = new Set<string>();
    for (const w of widgets) {
      for (const tp of w.topics) {
        if (!tp.trim() || seen.has(tp.trim())) continue;
        seen.add(tp.trim());
        void mqtt.subscribe(sessionId, tp.trim(), 0, null).catch(() => undefined);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicSig, connStatus, sessionId]);

  // --- autosave ---------------------------------------------------------------
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSaving(true);
      dash
        .save({ ...panel, name, json: JSON.stringify(json) })
        .then((p) => {
          onSaved(p);
          setSaving(false);
        })
        .catch(() => setSaving(false));
    }, 600);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [json, name]);

  // --- actions -----------------------------------------------------------------
  const publishValue = (w: DashWidget, value: unknown) => {
    // Optimistic local update: the widget reflects the user's action instantly,
    // even before any device echo arrives (and even when no publish topic is
    // configured yet — otherwise controls feel dead/unclickable in preview).
    setRuntimes((rt) => {
      const prev = rt[w.id]?.values ?? {};
      const next =
        value && typeof value === "object" && !Array.isArray(value)
          ? { ...prev, ...(value as Record<string, unknown>) }
          : { ...prev, value };
      return { ...rt, [w.id]: { raw: rt[w.id]?.raw ?? "", rawAt: rt[w.id]?.rawAt ?? 0, values: next, parseError: undefined } };
    });
    if (!sessionId || !w.pubTopic.trim()) {
      showToast(t("dash.noPubTopic"));
      return;
    }
    const res = runPublish(w.publishFn, value);
    if (!res.ok) {
      setRuntimes((rt) => ({ ...rt, [w.id]: { ...rt[w.id], values: rt[w.id]?.values ?? {}, parseError: `发布函数：${res.error}` } }));
      return;
    }
    void mqtt.publish(sessionId, w.pubTopic, utf8ToBase64(res.out), 0, false, null).catch(() => undefined);
    setLog((l) => [...l.slice(-499), { id: uid(), ts: Date.now(), topic: w.pubTopic, payload: res.out.slice(0, 400), dir: "out" }]);
  };

  const publishCommands = (w: DashWidget, cmds: { topic: string; payload: string }[]) => {
    if (!cmds.length) {
      showToast(t("dash.noSceneCmds"));
      return;
    }
    if (!sessionId) return;
    for (const c of cmds) {
      void mqtt.publish(sessionId, c.topic, utf8ToBase64(c.payload), 0, false, null).catch(() => undefined);
      setLog((l) => [...l.slice(-499), { id: uid(), ts: Date.now(), topic: c.topic, payload: c.payload.slice(0, 400), dir: "out" }]);
    }
  };

  const addWidget = (type: string) => {
    const meta = WIDGETS[type];
    if (!meta) return;
    const maxY = widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    const cfg: Record<string, unknown> = {};
    for (const f of meta.config ?? []) cfg[f.key] = f.def;
    const w: DashWidget = {
      id: uid(),
      type,
      x: 0,
      y: maxY,
      w: Math.min(meta.w, COLS),
      h: meta.h,
      title: t(meta.labelKey as never),
      topics: [],
      pubTopic: "",
      parseFn: meta.parse,
      publishFn: meta.publish ?? "",
      config: cfg,
    };
    setWidgets((ws) => [...ws, w]);
    setSelectedId(w.id);
    setEditMode(true);
  };

  const updateWidget = (id: string, patch: Partial<DashWidget>) =>
    setWidgets((ws) => ws.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const removeWidget = (id: string) => {
    setWidgets((ws) => ws.filter((x) => x.id !== id));
    setSelectedId((s) => (s === id ? null : s));
  };

  const onPointerDown = (e: ReactPointerEvent, w: DashWidget, mode: "move" | "resize") => {
    if (!editMode) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { id: w.id, mode, sx: e.clientX, sy: e.clientY, ow: { ...w }, colW: rect.width / COLS };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = (ev.clientX - d.sx) / d.colW;
      const dy = (ev.clientY - d.sy) / ROW_H;
      setWidgets((ws) =>
        ws.map((x) => {
          if (x.id !== d.id) return x;
          if (d.mode === "move")
            return { ...x, x: clamp(Math.round(d.ow.x + dx), 0, COLS - d.ow.w), y: Math.max(0, Math.round(d.ow.y + dy)) };
          return { ...x, w: clamp(Math.round(d.ow.w + dx), 1, COLS - x.x), h: clamp(Math.round(d.ow.h + dy), 1, MAX_H) };
        }),
      );
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // --- derived ------------------------------------------------------------------
  const selected = widgets.find((w) => w.id === selectedId) ?? null;
  const maxRow = Math.max(1, ...widgets.map((w) => w.y + w.h));
  const connected = connStatus === "connected";
  const bg = json.background;

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name || "panel"}.dash.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const j = parsePanel(String(reader.result));
        setJson(j);
        setSelectedId(null);
      } catch {
        /* invalid file — ignore */
      }
    };
    reader.readAsText(file);
  };

  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <Button variant="ghost" size="sm" onClick={onBack} title={t("dash.back")}>
          <ArrowLeft size={14} />
        </Button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-40 truncate rounded border border-transparent bg-transparent px-1.5 py-1 text-[13px] font-semibold text-fg outline-none hover:border-border focus:border-accent/60"
        />
        {connStatus === "connected" && (
          <span className="flex items-center gap-1 rounded bg-success/15 px-1.5 py-0.5 text-[11px] text-success">
            <Wifi size={11} /> {t("dash.connected")}
          </span>
        )}
        {connStatus === "connecting" && (
          <span className="flex items-center gap-1 rounded bg-hover px-1.5 py-0.5 text-[11px] text-subtle">
            <Loader2 size={11} className="animate-spin" /> {t("dash.connecting")}
          </span>
        )}
        {connStatus === "error" && (
          <span className="flex items-center gap-1 rounded bg-danger/15 px-1.5 py-0.5 text-[11px] text-danger" title={connError}>
            <WifiOff size={11} /> {t("dash.connError")}
          </span>
        )}
        {saving ? (
          <span className="flex items-center gap-1 text-[11px] text-subtle">
            <Loader2 size={11} className="animate-spin" /> {t("dash.saving")}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[11px] text-success">
            <Save size={11} /> {t("dash.saved")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button variant={editMode ? "primary" : "secondary"} size="sm" onClick={() => setEditMode(true)}>
            <PencilRuler size={13} /> {t("dash.edit")}
          </Button>
          <Button variant={editMode ? "secondary" : "primary"} size="sm" onClick={() => setEditMode(false)}>
            <Eye size={13} /> {t("dash.preview")}
          </Button>
          <div className="mx-1 h-4 w-px bg-border" />
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importJson(f);
              e.target.value = "";
            }}
          />
          <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} title={t("dash.import")}>
            <Upload size={14} />
          </Button>
          <Button variant="ghost" size="sm" onClick={exportJson} title={t("dash.export")}>
            <Download size={14} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowLib((s) => !s)} title={t("dash.addWidget")}>
            <Plus size={14} />
          </Button>
        </div>
      </div>

      {connStatus !== "connected" && connStatus !== "connecting" && panel.connectionId && (
        <div className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-[11px] text-warning">
          {connStatus === "error" ? `${t("dash.connError")}: ${connError}` : t("dash.offline")}
        </div>
      )}
      {toast && (
        <div className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-[11px] text-warning">{toast}</div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* widget library (edit mode) */}
        {editMode && showLib && (
          <aside className="flex w-52 shrink-0 flex-col border-r border-border/60 bg-surface/30">
            <div className="flex items-center justify-between border-b border-border/60 px-2 py-1.5">
              <span className="text-[11px] font-semibold text-subtle">{t("dash.library")}</span>
              <SideIconButton label={t("dash.collapseLib")} icon={<X size={13} />} onClick={() => setShowLib(false)} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {CATEGORY_KEYS.map((cat) => {
                const items = Object.values(WIDGETS).filter((m) => m.cat === cat);
                if (!items.length) return null;
                return (
                  <div key={cat} className="mb-2">
                    <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">{t(`dash.cat.${cat}` as never)}</div>
                    <div className="grid grid-cols-2 gap-1">
                      {items.map((m) => (
                        <button
                          key={m.type}
                          onClick={() => addWidget(m.type)}
                          className="flex items-center gap-1 rounded-md border border-border/60 bg-bg/50 px-1.5 py-1 text-[11px] text-fg transition-colors hover:border-accent/50 hover:bg-hover"
                        >
                          <span className="text-accent">{widgetIcon(m.type)}</span>
                          <span className="truncate">{t(m.labelKey as never)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
        )}

        {/* canvas */}
        <div className="relative min-w-0 flex-1 overflow-auto" onContextMenu={(e) => e.stopPropagation()}>
          <div
            className="relative mx-auto min-h-full"
            style={{
              width: "100%",
              // At least fill the visible area (min-h-full); taller when the
              // grid holds more rows than the viewport.
              height: Math.max(maxRow * ROW_H, 1),
              ...(bg.kind === "color"
                ? { background: bg.color ?? "#1a1b26" }
                : { backgroundImage: `url(${bg.image})`, backgroundSize: "cover", backgroundPosition: "center" }),
            }}
          >
            {/* background editor (edit mode) */}
            {editMode && (
              <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-lg border border-border/60 bg-surface/90 px-2 py-1 shadow">
                <Paintbrush size={12} className="text-subtle" />
                <input
                  type="color"
                  value={bg.kind === "color" ? bg.color : "#1a1b26"}
                  onChange={(e) => setJson((j) => ({ ...j, background: { kind: "color", color: e.target.value } }))}
                  className="h-5 w-7 cursor-pointer rounded border border-border bg-transparent p-0"
                  title={t("dash.bgColor")}
                />
                <input
                  value={bg.kind === "image" ? bg.image ?? "" : ""}
                  onChange={(e) => setJson((j) => ({ ...j, background: { kind: "image", image: e.target.value } }))}
                  placeholder={t("dash.bgImage")}
                  className="w-36 rounded border border-border/60 bg-bg px-1.5 py-0.5 text-[11px] text-fg outline-none focus:border-accent/60"
                />
              </div>
            )}

            {/* grid dots (edit mode) */}
            {editMode && (
              <div
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage:
                    "radial-gradient(circle, rgb(var(--c-border) / 0.35) 1px, transparent 1px)",
                  backgroundSize: `${100 / COLS}% ${ROW_H}px`,
                }}
              />
            )}

            <div ref={canvasRef} className={cn("relative h-full w-full", !connected && "opacity-70")}>
              {widgets.map((w) => {
                const meta = widgetMeta(w.type);
                const rt = runtimes[w.id];
                const isSel = selectedId === w.id;
                const leftPct = (w.x / COLS) * 100;
                const widthPct = (w.w / COLS) * 100;
                return (
                  <div
                    key={w.id}
                    className={cn("absolute", editMode && "cursor-grab")}
                    style={{ left: `${leftPct}%`, top: w.y * ROW_H, width: `${widthPct}%`, height: w.h * ROW_H }}
                    onPointerDown={editMode ? (e) => onPointerDown(e, w, "move") : undefined}
                  >
                    <WidgetRenderer
                      widget={w}
                      meta={meta ?? { type: w.type, cat: "info", labelKey: "dash.w.unknown", w: 2, h: 1, vars: [], template: "{}", parse: "return {};" }}
                      values={rt?.values ?? {}}
                      connected={connected}
                      log={log}
                      history={{ points: historyRef.current[w.id] ?? [] }}
                      onPublish={(value) => publishValue(w, value)}
                      onCommands={(cmds) => publishCommands(w, cmds)}
                      editing={editMode}
                      selected={isSel}
                      onSelect={() => setSelectedId(w.id)}
                    />
                    {editMode && isSel && (
                      <>
                        <div
                          className="absolute -right-1 -top-1 z-30 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full bg-danger text-white shadow"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeWidget(w.id);
                          }}
                        >
                          <Trash2 size={11} />
                        </div>
                        <div
                          className="absolute -bottom-1 -right-1 z-30 h-4 w-4 cursor-nwse-resize rounded-sm border border-border bg-accent"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            onPointerDown(e, w, "resize");
                          }}
                        />
                      </>
                    )}
                  </div>
                );
              })}
              {widgets.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-subtle">
                  <LayoutGrid size={30} />
                  <p className="text-[13px]">{t("dash.empty")}</p>
                  {editMode && (
                    <Button variant="secondary" size="sm" onClick={() => setShowLib(true)}>
                      <Plus size={13} /> {t("dash.addWidget")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* settings sidebar */}
        {selected && editMode && (
          <WidgetSettings
            key={selected.id}
            widget={selected}
            rt={runtimes[selected.id]}
            update={(patch) => updateWidget(selected.id, patch)}
            onDelete={() => removeWidget(selected.id)}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Widget settings sidebar
 * ------------------------------------------------------------------------- */

function WidgetSettings({
  widget,
  rt,
  update,
  onDelete,
  onClose,
}: {
  widget: DashWidget;
  rt?: { raw: string; rawAt: number; values: Record<string, unknown>; parseError?: string };
  update: (patch: Partial<DashWidget>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const meta = widgetMeta(widget.type);
  const [testRes, setTestRes] = useState<{ ok: boolean; detail: string } | null>(null);
  const [pubPreview, setPubPreview] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiTweak, setAiTweak] = useState("");
  const raw = rt?.raw ?? "";

  const runTest = (rawInput: string) => {
    const res = runParse(widget.parseFn, rawInput, widget.topics[0] ?? "");
    setTestRes(res.ok ? { ok: true, detail: JSON.stringify(res.out, null, 2) } : { ok: false, detail: res.error });
  };

  const aiGenerate = (instruction?: string) => {
    if (!meta || aiBusy) return;
    setAiBusy(true);
    setTestRes(null);
    const handle = aiGenerateParse(
      meta,
      raw,
      instruction,
      {
        onDelta: () => undefined,
        onDone: (code) => {
          update({ parseFn: code });
          setAiBusy(false);
          runTest(raw);
        },
        onError: (e) => {
          setAiBusy(false);
          setTestRes({ ok: false, detail: e });
        },
      },
    );
    // allow cancel by re-clicking while busy
    window.setTimeout(() => setAiBusy(false), 60000);
  };

  const previewPublish = () => {
    const sample = widget.type === "rgbInput" ? { r: 255, g: 136, b: 0 } : 50;
    const res = runPublish(widget.publishFn, sample);
    setPubPreview(res.ok ? res.out : `错误: ${res.error}`);
  };

  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-border/60 bg-surface/40">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-fg">
          <Settings2 size={13} className="text-accent" />
          {widget.title || t("dash.settings")}
        </span>
        <SideIconButton label={t("dash.collapseSettings")} icon={<X size={13} />} onClick={onClose} />
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {/* 基础设置 */}
        <Section title={t("dash.basic")}>
          <Field label={t("dash.name")}>
            <input className={inputCls} value={widget.title} onChange={(e) => update({ title: e.target.value })} />
          </Field>
          <Field label={t("dash.subTopics")}>
            <textarea
              className={cn(inputCls, "min-h-[54px] font-mono text-[11px]")}
              value={widget.topics.join("\n")}
              placeholder="sensor/temp&#10;sensor/#"
              onChange={(e) => update({ topics: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
            />
          </Field>
          <Field label={t("dash.pubTopic")}>
            <input className={cn(inputCls, "font-mono text-[11px]")} value={widget.pubTopic} placeholder="device/1/set" onChange={(e) => update({ pubTopic: e.target.value.trim() })} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("dash.width")}>
              <input type="number" min={1} max={COLS} className={inputCls} value={widget.w} onChange={(e) => update({ w: clamp(Number(e.target.value) || 1, 1, COLS) })} />
            </Field>
            <Field label={t("dash.height")}>
              <input type="number" min={1} max={MAX_H} className={inputCls} value={widget.h} onChange={(e) => update({ h: clamp(Number(e.target.value) || 1, 1, MAX_H) })} />
            </Field>
          </div>
        </Section>

        {meta && meta.vars.length > 0 && (
          <Section title={t("dash.data")}>
            {/* 显示位变量说明 */}
            <div className="rounded-md border border-border/60 bg-bg/60 p-2">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">{t("dash.vars")}</div>
              <div className="space-y-0.5">
                {meta.vars.map((v) => (
                  <div key={v.key} className="flex items-baseline gap-1.5 text-[11px]">
                    <code className="shrink-0 rounded bg-hover px-1 text-accent">{v.key}</code>
                    <span className="shrink-0 text-subtle">{v.type}</span>
                    <span className="min-w-0 truncate text-fg/70">{v.desc}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 最新原始数据 */}
            <div className="rounded-md border border-border/60 bg-bg/60 p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">{t("dash.latestRaw")}</span>
                {rt?.rawAt ? (
                  <span className="text-[10px] text-subtle">{new Date(rt.rawAt).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                ) : null}
              </div>
              {raw ? (
                <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-snug text-fg/80">{raw}</pre>
              ) : (
                <div className="text-[11px] text-warning">{t("dash.noData")}</div>
              )}
            </div>

            {/* 解析函数 */}
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">{t("dash.parseFn")}</span>
              <div className="flex gap-1">
                <button className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-fg hover:bg-border" onClick={() => update({ parseFn: meta.parse })}>
                  {t("dash.applyDefault")}
                </button>
                <button className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-fg hover:bg-border" onClick={() => runTest(meta.template)}>
                  {t("dash.testWithTemplate")}
                </button>
              </div>
            </div>
            <MiniEditor value={widget.parseFn} onChange={(v) => update({ parseFn: v })} height={150} />

            {/* 测试 */}
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => runTest(raw)} disabled={!raw}>
                <Play size={12} /> {t("dash.test")}
              </Button>
              {rt?.parseError && !testRes && <span className="truncate text-[10px] text-danger">{t("dash.parseError")}</span>}
            </div>
            {testRes && (
              <pre className={cn("max-h-36 overflow-auto whitespace-pre-wrap rounded-md border p-2 font-mono text-[10px]", testRes.ok ? "border-success/40 bg-success/10 text-success" : "border-danger/40 bg-danger/10 text-danger")}>
                {testRes.detail}
              </pre>
            )}

            {/* AI 辅助 */}
            <div className="rounded-md border border-border/60 bg-bg/60 p-2">
              <div className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">
                <Wand2 size={11} /> {t("dash.ai")}
              </div>
              {!raw && <div className="mb-1.5 text-[11px] text-warning">{t("dash.aiHint")}</div>}
              <div className="flex gap-1.5">
                <Button variant="primary" size="sm" disabled={!raw || !hasAiConfig() || aiBusy} onClick={() => aiGenerate(undefined)}>
                  {aiBusy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} {t("dash.aiGen")}
                </Button>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <input className={cn(inputCls, "min-w-0 flex-1 text-[11px]")} value={aiTweak} placeholder={t("dash.aiTweak")} onChange={(e) => setAiTweak(e.target.value)} />
                <Button variant="secondary" size="sm" disabled={!raw || !hasAiConfig() || aiBusy || !aiTweak.trim()} onClick={() => aiGenerate(aiTweak.trim())}>
                  {t("dash.aiTweakBtn")}
                </Button>
              </div>
            </div>
          </Section>
        )}

        {/* 发布配置 */}
        {meta?.publish && (
          <Section title={t("dash.publish")}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">{t("dash.publishFn")}</span>
              <button className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-fg hover:bg-border" onClick={() => update({ publishFn: meta.publish! })}>
                {t("dash.applyDefault")}
              </button>
            </div>
            <MiniEditor value={widget.publishFn} onChange={(v) => update({ publishFn: v })} height={110} />
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={previewPublish}>
                {t("dash.previewPublish")}
              </Button>
              {meta.publishSample && <span className="truncate text-[10px] text-subtle">{meta.publishSample}</span>}
            </div>
            {pubPreview && (
              <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/50 bg-bg/60 p-2 font-mono text-[10px] text-info">{pubPreview}</pre>
            )}
          </Section>
        )}

        <Button variant="ghost" size="sm" className="w-full justify-center text-danger hover:bg-danger/10" onClick={onDelete}>
          <Trash2 size={13} /> {t("dash.delete")}
        </Button>
      </div>
    </aside>
  );
}

const inputCls =
  "w-full rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-fg outline-none focus:border-accent/60";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold text-fg/80">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-subtle">{label}</div>
      {children}
    </div>
  );
}
