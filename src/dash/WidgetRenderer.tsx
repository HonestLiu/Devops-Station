import { useEffect, useRef, useState } from "react";
import {
  Camera,
  Droplets,
  Gauge as GaugeIcon,
  Lock,
  LockOpen,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Thermometer,
  Wind,
  Wifi,
  WifiOff,
  Zap,
  BatteryCharging,
  Battery,
  Activity,
  BellRing,
  AlarmClock,
  Home,
  PersonStanding,
  Image as ImageIcon,
  Lightbulb,
  Snowflake,
  SunMedium,
  Eye,
} from "lucide-react";
import type { DashWidget } from "@/lib/types";
import { widgetMeta, type WidgetMeta } from "./registry";
import { cn } from "@/lib/utils";

export interface DashLogEntry {
  id: string;
  ts: number;
  topic: string;
  payload: string;
  dir: "in" | "out";
}

export interface RenderCtx {
  widget: DashWidget;
  meta: WidgetMeta;
  values: Record<string, unknown>;
  connected: boolean;
  log: DashLogEntry[];
  history?: { points: Record<string, number>[] };
  onPublish: (value: unknown) => void;
  onCommands: (cmds: { topic: string; payload: string }[]) => void;
  editing: boolean;
  selected: boolean;
  onSelect: () => void;
}

const num = (v: unknown, d = 0): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: unknown, d = false): boolean => (typeof v === "boolean" ? v : !!v);
const str = (v: unknown, d = ""): string => (v == null ? d : String(v));
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const pct = (v: unknown, d = 0) => clamp(num(v, d), 0, 100);

/** Click dispatch: editing selects the widget, running mode acts on it. */
const click = (ctx: RenderCtx, act?: () => void) => () => {
  if (ctx.editing) ctx.onSelect();
  else act?.();
};

/** Title bar shown by most cards. */
function Title({ title }: { title: string }) {
  if (!title) return null;
  return (
    <div className="truncate px-2 pt-1.5 text-[11px] font-medium leading-tight text-fg/70">
      {title}
    </div>
  );
}

/** Generic card wrapper. */
function Card({
  ctx,
  onClick,
  children,
  className,
}: {
  ctx: RenderCtx;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "flex h-full w-full select-none flex-col overflow-hidden rounded-lg border bg-surface/70",
        ctx.selected ? "border-accent ring-1 ring-accent/50" : "border-border/60",
        onClick && "cursor-pointer",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Unified control button used inside widget cards (mode toggles, scene
 * triggers, media transport, curtain controls, …). One consistent border,
 * padding, hover and selected state so the whole dashboard reads as a single
 * family instead of a pile of mismatched `bg-hover` pills.
 */
function CtrlBtn({
  active,
  className,
  children,
  ...rest
}: {
  active?: boolean;
  className?: string;
  children?: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={cn(
        "inline-flex select-none items-center justify-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        active
          ? "border-accent/50 bg-accent/15 text-accent"
          : "border-border/70 bg-bg/40 text-subtle hover:border-border hover:bg-hover hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Big monospace value. */
function BigValue({ value, unit, big }: { value: string; unit?: string; big?: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 items-baseline justify-center gap-1 px-2">
      <span
        className={cn("truncate font-mono font-semibold text-fg", big ? "text-[26px]" : "text-[20px]")}
      >
        {value || "--"}
      </span>
      {unit && <span className="shrink-0 text-[11px] text-subtle">{unit}</span>}
    </div>
  );
}

function ValueRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-2 text-[11px]">
      <span className="shrink-0 text-subtle">{label}</span>
      <span className={cn("truncate font-mono", color ?? "text-fg")}>{value || "--"}</span>
    </div>
  );
}

/* --- charts (canvas) -------------------------------------------------------- */

function useChartDraw(
  ref: React.RefObject<HTMLCanvasElement | null>,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  deps: unknown[],
) {
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = cv.getBoundingClientRect();
    const w = Math.max(10, Math.floor(rect.width));
    const h = Math.max(10, Math.floor(rect.height));
    cv.width = w * dpr;
    cv.height = h * dpr;
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    draw(g, w, h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function LineChart({ points, keys }: { points: Record<string, number>[]; keys: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const palette = ["#7aa2f7", "#9ece6a", "#e0af68", "#f7768e", "#7dcfff", "#bb9af7"];
  useChartDraw(
    ref,
    (g, w, h) => {
      const pad = 4;
      const n = points.length;
      if (!n || !keys.length) {
        g.fillStyle = "#565f89";
        g.font = "11px sans-serif";
        g.fillText("暂无数据", 8, h / 2);
        return;
      }
      const min = Math.min(...points.flatMap((p) => keys.map((k) => p[k] ?? 0)));
      const max = Math.max(...points.flatMap((p) => keys.map((k) => p[k] ?? 0)));
      const lo = min === max ? min - 1 : min;
      const hi = max === min ? max + 1 : max;
      keys.forEach((k, ki) => {
        g.strokeStyle = palette[ki % palette.length];
        g.lineWidth = 1.5;
        g.beginPath();
        points.forEach((p, i) => {
          const x = pad + (i / (n - 1)) * (w - pad * 2);
          const y = h - pad - ((p[k] ?? lo) - lo) / (hi - lo) * (h - pad * 2);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        });
        g.stroke();
      });
    },
    [points, keys],
  );
  return <canvas ref={ref} className="h-full w-full" />;
}

function BarChart({ points, keys }: { points: Record<string, number>[]; keys: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const palette = ["#7aa2f7", "#9ece6a", "#e0af68", "#f7768e", "#7dcfff", "#bb9af7"];
  useChartDraw(
    ref,
    (g, w, h) => {
      const n = points.length;
      if (!n || !keys.length) {
        g.fillStyle = "#565f89";
        g.font = "11px sans-serif";
        g.fillText("暂无数据", 8, h / 2);
        return;
      }
      const last = points[n - 1];
      const values = keys.map((k) => last[k] ?? 0);
      const max = Math.max(...values, 1);
      const slot = w / keys.length;
      keys.forEach((k, ki) => {
        const v = last[k] ?? 0;
        const bh = clamp(v / max, 0, 1) * (h - 8);
        g.fillStyle = palette[ki % palette.length];
        g.fillRect(ki * slot + 6, h - bh, slot - 12, bh);
      });
    },
    [points, keys],
  );
  return <canvas ref={ref} className="h-full w-full" />;
}

/* --- gauge (SVG semicircle) ------------------------------------------------- */

function Gauge({ value, min, max, unit }: { value: number; min: number; max: number; unit?: string }) {
  const p = clamp((value - min) / (max - min || 1), 0, 1);
  const R = 38;
  const TOTAL = Math.PI * R; // half circle
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
      <svg viewBox="0 0 100 62" className="w-full max-w-[120px]">
        <path d="M 12 50 A 38 38 0 0 1 88 50" fill="none" stroke="rgb(var(--c-border))" strokeWidth="7" strokeLinecap="round" />
        <path
          d="M 12 50 A 38 38 0 0 1 88 50"
          fill="none"
          stroke="rgb(var(--c-accent))"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={`${TOTAL * p} ${TOTAL}`}
        />
        <text x="50" y="58" textAnchor="middle" fontSize="15" fontWeight="600" fill="rgb(var(--c-fg))">
          {Number.isFinite(value) ? value.toFixed(1) : "--"}
        </text>
        {unit && (
          <text x="50" y="14" textAnchor="middle" fontSize="8" fill="rgb(var(--c-subtle))">
            {unit}
          </text>
        )}
      </svg>
    </div>
  );
}

/* --- switch / knob ---------------------------------------------------------- */

function Switch({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      onClick={onChange}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors",
        on ? "bg-accent" : "bg-border",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
          on ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}

function Knob({ value, min, max, unit, onChange, interactive }: { value: number; min: number; max: number; unit?: string; onChange: (v: number) => void; interactive: boolean }) {
  const p = clamp((value - min) / (max - min || 1), 0, 1);
  const angle = -135 + 270 * p; // -135°..+135°
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const onPointer = (e: React.PointerEvent) => {
    if (!interactive) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag(true);
    const move = (ev: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI; // -180..180
      const norm = ((a + 225) % 360 + 360) % 360; // 0 at bottom-left, CCW
      const p2 = clamp(norm / 270, 0, 1);
      onChange(min + p2 * (max - min));
    };
    const up = () => {
      setDrag(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className={cn("relative mx-auto flex h-full w-full max-w-[110px] items-center justify-center", interactive && "cursor-ns-resize")} onPointerDown={onPointer}>
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgb(var(--c-border))" strokeWidth="8" strokeDasharray={`${(270 / 360) * 2 * Math.PI * 42} ${2 * Math.PI * 42}`} transform="rotate(135 50 50)" />
        <circle
          cx="50"
          cy="50"
          r="42"
          fill="none"
          stroke="rgb(var(--c-accent))"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${(p * 270 / 360) * 2 * Math.PI * 42} ${2 * Math.PI * 42}`}
          transform="rotate(135 50 50)"
          style={{ opacity: drag ? 0.7 : 1 }}
        />
        <line x1="50" y1="50" x2={50 + 30 * Math.sin((angle * Math.PI) / 180)} y2={50 - 30 * Math.cos((angle * Math.PI) / 180)} stroke="rgb(var(--c-fg))" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-[15px] font-semibold text-fg">{Number.isFinite(value) ? Math.round(value) : "--"}</span>
        {unit && <span className="text-[9px] text-subtle">{unit}</span>}
      </div>
    </div>
  );
}

/* --- main renderer ---------------------------------------------------------- */

export function WidgetRenderer(ctx: RenderCtx) {
  const { widget, meta, values, connected } = ctx;
  const v = values ?? {};
  const cfg = widget.config ?? {};
  const title = <Title title={widget.title} />;
  const running = !ctx.editing;

  switch (widget.type) {
    // ---- 基础操作 ------------------------------------------------------------
    case "button": {
      const mode = str(cfg.mode, "momentary");
      const onP = str(cfg.onPayload, "ON");
      const offP = str(cfg.offPayload, "OFF");
      const on = bool(v.pressed);
      return (
        <Card ctx={ctx} className="items-center justify-center gap-1">
          {title}
          <CtrlBtn
            active={on}
            className="flex-1 text-[13px]"
            onClick={() => click(ctx, () => ctx.onPublish(mode === "latching" ? (on ? offP : onP) : onP))()}
          >
            {mode === "latching" ? (on ? "ON" : "OFF") : "按住"}
          </CtrlBtn>
        </Card>
      );
    }
    case "toggle": {
      const on = bool(v.value);
      return (
        <Card ctx={ctx} onClick={click(ctx, () => ctx.onPublish(!on))} className="items-center justify-center gap-2 px-3">
          {title}
          <div className="flex flex-1 items-center justify-center gap-3">
            <span className="text-[12px] text-subtle">{on ? "开" : "关"}</span>
            <Switch on={on} onChange={() => running && ctx.onPublish(!on)} />
          </div>
        </Card>
      );
    }
    case "slider":
    case "volumeSlider": {
      const min = num(cfg.min, 0);
      const max = num(cfg.max, 100);
      const value = clamp(num(v.value ?? v.volume), min, max);
      const label = widget.type === "volumeSlider" ? "音量" : undefined;
      return (
        <Card ctx={ctx} className="gap-1 px-3 py-1.5">
          <div className="flex items-center justify-between">
            {title || (label && <span className="text-[11px] text-subtle">{label}</span>)}
            <span className="font-mono text-[12px] text-fg">{Math.round(value)}</span>
          </div>
          <input
            type="range"
            min={min}
            max={max}
            value={value}
            disabled={!running}
            onChange={(e) => ctx.onPublish(Number(e.target.value))}
            className="w-full accent-[rgb(var(--c-accent))]"
          />
        </Card>
      );
    }
    case "knob": {
      const min = num(cfg.min, 0);
      const max = num(cfg.max, 100);
      const value = clamp(num(v.value), min, max);
      return (
        <Card ctx={ctx} className="p-1">
          {title}
          <Knob value={value} min={min} max={max} unit={str(cfg.unit)} interactive={running} onChange={(n) => ctx.onPublish(n)} />
        </Card>
      );
    }

    // ---- 颜色 / 光效 ----------------------------------------------------------
    case "colorPicker": {
      const color = str(v.color, "#FFFFFF");
      return (
        <Card ctx={ctx} className="items-center justify-center gap-1.5">
          {title}
          <div className="flex flex-1 items-center justify-center gap-2 px-2">
            <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : "#FFFFFF"} disabled={!running} onChange={(e) => ctx.onPublish(e.target.value)} className="h-9 w-14 cursor-pointer rounded border border-border bg-transparent p-0.5" />
            <span className="font-mono text-[11px] text-subtle">{color}</span>
          </div>
        </Card>
      );
    }
    case "colorTemp": {
      const min = num(cfg.min, 2700);
      const max = num(cfg.max, 6500);
      const value = clamp(num(v.temp, 4000), min, max);
      return (
        <Card ctx={ctx} className="gap-1 px-3 py-1.5">
          <div className="flex items-center justify-between">
            {title || <span className="text-[11px] text-subtle">色温</span>}
            <span className="font-mono text-[12px] text-fg">{Math.round(value)}K</span>
          </div>
          <input type="range" min={min} max={max} value={value} disabled={!running} onChange={(e) => ctx.onPublish(Number(e.target.value))} className="w-full accent-[rgb(var(--c-warning))]" />
        </Card>
      );
    }
    case "rgbInput": {
      const r = num(v.r, 255);
      const g = num(v.g, 255);
      const b = num(v.b, 255);
      const hex = `#${[r, g, b].map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
      return (
        <Card ctx={ctx} className="gap-1 p-2">
          {title}
          <div className="flex flex-1 items-center gap-2">
            <div className="h-8 w-8 shrink-0 rounded-md border border-border" style={{ background: hex }} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {(["r", "g", "b"] as const).map((k, i) => (
                <input key={k} type="range" min={0} max={255} value={k === "r" ? r : k === "g" ? g : b} disabled={!running} onChange={(e) => ctx.onPublish({ r: k === "r" ? Number(e.target.value) : r, g: k === "g" ? Number(e.target.value) : g, b: k === "b" ? Number(e.target.value) : b })} className="w-full accent-[rgb(var(--c-accent))]" />
              ))}
            </div>
            <span className="shrink-0 font-mono text-[10px] text-subtle">{hex}</span>
          </div>
        </Card>
      );
    }

    // ---- 数据显示 --------------------------------------------------------------
    case "gauge":
      return (
        <Card ctx={ctx} className="p-1">
          {title}
          <Gauge value={num(v.value)} min={num(cfg.min, 0)} max={num(cfg.max, 100)} unit={str(v.unit)} />
        </Card>
      );
    case "numberText":
      return (
        <Card ctx={ctx} className="p-1">
          {title}
          <BigValue value={str(v.text)} unit={str(v.unit)} />
        </Card>
      );
    case "progress":
      return (
        <Card ctx={ctx} className="gap-1 px-3 py-1.5">
          <div className="flex items-center justify-between">
            {title || (v.label && <span className="truncate text-[11px] text-subtle">{str(v.label)}</span>)}
            <span className="font-mono text-[12px] text-fg">{Math.round(pct(v.value))}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${pct(v.value)}%` }} />
          </div>
        </Card>
      );
    case "battery": {
      const level = pct(v.level);
      const charging = bool(v.charging);
      const color = level > 50 ? "rgb(var(--c-success))" : level > 20 ? "rgb(var(--c-warning))" : "rgb(var(--c-danger))";
      return (
        <Card ctx={ctx} className="items-center justify-center gap-1">
          {title}
          <div className="flex flex-1 items-center justify-center gap-2">
            {charging ? <BatteryCharging size={20} style={{ color }} /> : <Battery size={20} style={{ color }} />}
            <span className="font-mono text-[15px] font-semibold text-fg">{Math.round(level)}%</span>
          </div>
        </Card>
      );
    }

    // ---- 环境监测 --------------------------------------------------------------
    case "tempCard":
      return (
        <Card ctx={ctx} className="p-1">
          {title}
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-2">
            <Thermometer size={18} className="shrink-0 text-danger" />
            <span className="font-mono text-[24px] font-semibold text-fg">{num(v.temp) ? num(v.temp).toFixed(1) : "--"}</span>
            <span className="text-[12px] text-subtle">{str(v.unit, "℃")}</span>
          </div>
        </Card>
      );
    case "humidityCard":
      return (
        <Card ctx={ctx} className="p-1">
          {title}
          <div className="flex min-h-0 flex-1 items-center justify-center gap-2 px-2">
            <Droplets size={18} className="shrink-0 text-info" />
            <span className="font-mono text-[24px] font-semibold text-fg">{num(v.humidity) ? `${Math.round(num(v.humidity))}` : "--"}</span>
            <span className="text-[12px] text-subtle">%</span>
          </div>
        </Card>
      );
    case "pm25Card":
      return (
        <Card ctx={ctx} className="p-1">
          {title}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
            <span className="font-mono text-[22px] font-semibold text-fg">{num(v.pm25) ? Math.round(num(v.pm25)) : "--"}</span>
            <span className="text-[10px] text-subtle">PM2.5 {str(v.level)}</span>
          </div>
        </Card>
      );
    case "envCard":
      return (
        <Card ctx={ctx} className="p-1.5">
          {title}
          <div className="grid min-h-0 flex-1 grid-cols-3 gap-1">
            <div className="flex flex-col items-center justify-center rounded bg-hover/50">
              <Thermometer size={13} className="mb-0.5 text-danger" />
              <span className="font-mono text-[15px] font-semibold text-fg">{num(v.temp) ? num(v.temp).toFixed(1) : "--"}{str(v.unit, "℃")}</span>
            </div>
            <div className="flex flex-col items-center justify-center rounded bg-hover/50">
              <Droplets size={13} className="mb-0.5 text-info" />
              <span className="font-mono text-[15px] font-semibold text-fg">{num(v.humidity) ? `${Math.round(num(v.humidity))}%` : "--"}</span>
            </div>
            <div className="flex flex-col items-center justify-center rounded bg-hover/50">
              <Wind size={13} className="mb-0.5 text-success" />
              <span className="font-mono text-[15px] font-semibold text-fg">{num(v.pm25) ? Math.round(num(v.pm25)) : "--"}</span>
            </div>
          </div>
        </Card>
      );

    // ---- 媒体控制 --------------------------------------------------------------
    case "mediaControls": {
      const playing = bool(v.playing);
      return (
        <Card ctx={ctx} className="items-center justify-center gap-1">
          {title}
          <div className="flex flex-1 items-center justify-center gap-2">
            <CtrlBtn disabled={!running} className="p-1.5" onClick={click(ctx, () => ctx.onPublish("prev"))}><SkipBack size={16} /></CtrlBtn>
            <CtrlBtn disabled={!running} className="border-accent/50 bg-accent p-2 text-accent-fg hover:opacity-90" onClick={click(ctx, () => ctx.onPublish("toggle"))}>
              {playing ? <Pause size={16} /> : <Play size={16} />}
            </CtrlBtn>
            <CtrlBtn disabled={!running} className="p-1.5" onClick={click(ctx, () => ctx.onPublish("next"))}><SkipForward size={16} /></CtrlBtn>
          </div>
        </Card>
      );
    }
    case "songInfo":
      return (
        <Card ctx={ctx} className="justify-center gap-0.5 p-2">
          {title}
          <div className="truncate text-center text-[14px] font-semibold text-fg">{str(v.title) || "--"}</div>
          <div className="truncate text-center text-[11px] text-subtle">
            {str(v.artist)}
            {v.album ? ` · ${str(v.album)}` : ""}
          </div>
        </Card>
      );

    // ---- 安防 / 门窗 ------------------------------------------------------------
    case "lockCard": {
      const locked = bool(v.locked);
      return (
        <Card ctx={ctx} onClick={click(ctx, () => ctx.onPublish(!locked))} className="items-center justify-center gap-1">
          {title}
          <div className="flex flex-1 flex-col items-center justify-center">
            {locked ? <Lock size={26} className="text-success" /> : <LockOpen size={26} className="text-warning" />}
            <span className={cn("mt-1 rounded px-1.5 py-0.5 text-[10px] font-medium", locked ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>
              {locked ? "已锁定" : "未锁定"}
            </span>
          </div>
        </Card>
      );
    }
    case "doorSensor": {
      const open = bool(v.open);
      return (
        <Card ctx={ctx} className="items-center justify-center gap-1">
          {title}
          <div className="flex flex-1 flex-col items-center justify-center">
            <span className={cn("text-[20px] font-semibold", open ? "text-warning" : "text-success")}>{open ? "开" : "关"}</span>
            <span className="text-[10px] text-subtle">门窗磁</span>
          </div>
        </Card>
      );
    }
    case "motionSensor": {
      const motion = bool(v.motion);
      return (
        <Card ctx={ctx} className="items-center justify-center gap-1">
          {title}
          <div className="flex flex-1 flex-col items-center justify-center">
            <PersonStanding size={24} className={motion ? "text-warning" : "text-subtle"} />
            <span className={cn("mt-1 rounded px-1.5 py-0.5 text-[10px] font-medium", motion ? "bg-warning/15 text-warning" : "bg-hover text-subtle")}>
              {motion ? "检测到人体" : "无人"}
            </span>
          </div>
        </Card>
      );
    }
    case "cameraCard":
      return (
        <Card ctx={ctx} className="p-1">
          {title}
          <div className="relative m-1 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded bg-black/40">
            {str(v.snapshot) ? (
              <img src={str(v.snapshot)} alt="" className="h-full w-full object-cover" />
            ) : (
              <Camera size={26} className="text-subtle" />
            )}
            <span className={cn("absolute bottom-1 right-1 rounded px-1.5 py-0.5 text-[10px] font-medium", bool(v.online, true) ? "bg-success/80 text-black" : "bg-danger/80 text-white")}>
              {bool(v.online, true) ? "在线" : "离线"}
            </span>
          </div>
        </Card>
      );

    // ---- 场景 / 自动化 ----------------------------------------------------------
    case "sceneButton": {
      const cmds = (() => {
        try {
          const c = JSON.parse(str(cfg.commands, "[]"));
          return Array.isArray(c) ? c.filter((x) => x && x.topic) : [];
        } catch {
          return [];
        }
      })() as { topic: string; payload: string }[];
      return (
        <Card ctx={ctx} onClick={click(ctx, () => ctx.onCommands(cmds))} className="items-center justify-center">
          {title}
          <div className="flex flex-1 items-center justify-center gap-1.5">
            <Zap size={15} className="text-warning" />
            <span className="text-[13px] font-medium text-fg">执行场景</span>
          </div>
        </Card>
      );
    }
    case "timerCard":
      return (
        <Card ctx={ctx} className="p-2">
          {title}
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1">
            <AlarmClock size={18} className="text-accent" />
            <span className="font-mono text-[16px] font-semibold text-fg">{str(v.next) || "--:--"}</span>
            {num(v.countdown) > 0 && <span className="text-[10px] text-subtle">剩余 {Math.ceil(num(v.countdown))}s</span>}
          </div>
        </Card>
      );

    // ---- 信息展示 --------------------------------------------------------------
    case "textLabel":
      return (
        <Card ctx={ctx} className="items-center justify-center p-2">
          <div className="truncate text-center text-[13px] text-fg">{str(v.text, widget.title)}</div>
        </Card>
      );
    case "logList": {
      const kw = str(cfg.filter).trim().toLowerCase();
      const rows = ctx.log.filter((l) => !kw || l.topic.toLowerCase().includes(kw) || l.payload.toLowerCase().includes(kw)).slice(-200).reverse();
      return (
        <Card ctx={ctx} className="p-1">
          <div className="flex items-center justify-between px-2 pt-1">
            <span className="truncate text-[11px] font-medium text-fg/70">{widget.title || "日志"}</span>
            <span className="text-[10px] text-subtle">{rows.length} 条</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1 font-mono text-[10px] leading-[1.5]">
            {rows.length === 0 ? (
              <div className="p-2 text-subtle">暂无消息</div>
            ) : (
              rows.map((l) => (
                <div key={l.id} className="flex gap-1.5 border-b border-border/40 py-0.5">
                  <span className={cn("shrink-0", l.dir === "in" ? "text-success" : "text-accent")}>{l.dir === "in" ? "↓" : "↑"}</span>
                  <span className="shrink-0 text-subtle">{new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false })}</span>
                  <span className="shrink-0 max-w-[40%] truncate text-info">{l.topic}</span>
                  <span className="min-w-0 flex-1 truncate text-fg/80">{l.payload}</span>
                </div>
              ))
            )}
          </div>
        </Card>
      );
    }
    case "imageCard":
      return (
        <Card ctx={ctx} className="p-1">
          {title}
          <div className="m-1 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded bg-hover/60">
            {str(v.src) ? (
              <img src={str(v.src)} alt="" className="h-full w-full object-cover" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
            ) : (
              <ImageIcon size={20} className="text-subtle" />
            )}
          </div>
        </Card>
      );
    case "divider":
      return <div className="mx-2 my-auto h-px bg-border" />;
    case "clockCard":
      return <ClockWidget title={widget.title} />;

    // ---- 复合卡片 --------------------------------------------------------------
    case "lightCard": {
      const on = bool(v.power);
      return (
        <Card ctx={ctx} className="gap-1 p-2">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-[12px] font-medium text-fg">
              <Lightbulb size={13} className={on ? "text-warning" : "text-subtle"} />
              {widget.title || "灯"}
            </span>
            <Switch on={on} onChange={() => running && ctx.onPublish({ ...v, power: !on })} />
          </div>
          <input type="range" min={0} max={100} value={pct(v.brightness)} disabled={!running} onChange={(e) => ctx.onPublish({ ...v, brightness: Number(e.target.value) })} className="w-full accent-[rgb(var(--c-warning))]" />
          <div className="flex items-center gap-2">
            {num(v.temp) > 0 && (
              <input type="range" min={2700} max={6500} value={clamp(num(v.temp), 2700, 6500)} disabled={!running} onChange={(e) => ctx.onPublish({ ...v, temp: Number(e.target.value) })} className="w-full accent-[rgb(var(--c-accent))]" />
            )}
            {str(v.color) && <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(str(v.color)) ? str(v.color) : "#FFFFFF"} disabled={!running} onChange={(e) => ctx.onPublish({ ...v, color: e.target.value })} className="h-6 w-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0" />}
          </div>
        </Card>
      );
    }
    case "acCard": {
      const on = bool(v.power);
      return (
        <Card ctx={ctx} className="gap-1 p-2">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-[12px] font-medium text-fg">
              <Snowflake size={13} className={on ? "text-info" : "text-subtle"} />
              {widget.title || "空调"}
            </span>
            <Switch on={on} onChange={() => running && ctx.onPublish({ ...v, power: !on })} />
          </div>
          <div className="flex items-center justify-between gap-1 text-[11px]">
            <span className="text-subtle">模式</span>
            <div className="flex gap-0.5">
              {["auto", "cool", "heat", "fan"].map((m) => (
                <CtrlBtn key={m} active={str(v.mode) === m} disabled={!running} onClick={click(ctx, () => ctx.onPublish({ ...v, mode: m }))}>
                  {m}
                </CtrlBtn>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-1 text-[11px]">
            <span className="text-subtle">温度</span>
            <span className="flex items-center gap-1">
              <CtrlBtn disabled={!running} className="h-5 px-1.5" onClick={click(ctx, () => ctx.onPublish({ ...v, temp: clamp(num(v.temp, 26) - 1, 16, 30) }))}>−</CtrlBtn>
              <span className="w-7 text-center font-mono text-[13px] text-fg">{Math.round(num(v.temp, 26))}°</span>
              <CtrlBtn disabled={!running} className="h-5 px-1.5" onClick={click(ctx, () => ctx.onPublish({ ...v, temp: clamp(num(v.temp, 26) + 1, 16, 30) }))}>+</CtrlBtn>
            </span>
          </div>
          <input type="range" min={0} max={100} value={pct(v.fan)} disabled={!running} onChange={(e) => ctx.onPublish({ ...v, fan: Number(e.target.value) })} className="w-full accent-[rgb(var(--c-info))]" />
        </Card>
      );
    }
    case "curtainCard": {
      const pos = pct(v.position);
      return (
        <Card ctx={ctx} className="gap-1 p-2">
          <span className="text-[12px] font-medium text-fg">{widget.title || "窗帘"}</span>
          <div className="flex min-h-0 flex-1 items-end justify-center overflow-hidden rounded bg-hover/40">
            <div className="flex items-end transition-all" style={{ height: "100%" }}>
              <div className="h-full bg-accent/40" style={{ width: 14 }} />
              <div className="h-full bg-accent/70" style={{ width: 14 }} />
            </div>
            <span className="absolute self-center font-mono text-[14px] font-semibold text-fg">{Math.round(pos)}%</span>
          </div>
          <div className="flex items-center justify-center gap-1">
            <CtrlBtn disabled={!running} onClick={click(ctx, () => ctx.onPublish({ position: 0, moving: "close" }))}>全关</CtrlBtn>
            <CtrlBtn disabled={!running} onClick={click(ctx, () => ctx.onPublish({ position: 50, moving: "stop" }))}>停</CtrlBtn>
            <CtrlBtn disabled={!running} onClick={click(ctx, () => ctx.onPublish({ position: 100, moving: "open" }))}>全开</CtrlBtn>
          </div>
        </Card>
      );
    }

    // ---- 图表类 ----------------------------------------------------------------
    case "lineChart": {
      const keys = str(cfg.series).split(",").map((s) => s.trim()).filter(Boolean);
      const allKeys = [...new Set((ctx.history?.points ?? []).flatMap((p) => Object.keys(p)))];
      const used = keys.length ? keys : allKeys;
      return (
        <Card ctx={ctx} className="p-1">
          <div className="px-2 pt-1 text-[11px] font-medium text-fg/70">{widget.title || "实时曲线"}</div>
          <div className="min-h-0 flex-1 px-1 pb-1">
            <LineChart points={ctx.history?.points ?? []} keys={used} />
          </div>
        </Card>
      );
    }
    case "barChart": {
      const keys = str(cfg.series).split(",").map((s) => s.trim()).filter(Boolean);
      const last = ctx.history?.points?.[ctx.history.points.length - 1] ?? {};
      const allKeys = Object.keys(last);
      const used = keys.length ? keys : allKeys;
      return (
        <Card ctx={ctx} className="p-1">
          <div className="px-2 pt-1 text-[11px] font-medium text-fg/70">{widget.title || "柱状图"}</div>
          <div className="min-h-0 flex-1 px-1 pb-1">
            <BarChart points={ctx.history?.points ?? []} keys={used} />
          </div>
        </Card>
      );
    }

    // ---- 告警类 ----------------------------------------------------------------
    case "alarmLight": {
      const triggered = bool(v.triggered, num(v.value) > num(cfg.threshold, 80));
      return (
        <Card ctx={ctx} className="items-center justify-center gap-1">
          {title}
          <div className="flex flex-1 items-center justify-center gap-2 px-2">
            <span className={cn("h-3 w-3 rounded-full", triggered ? "animate-pulse bg-danger" : "bg-success")} />
            <span className={cn("text-[12px] font-medium", triggered ? "text-danger" : "text-success")}>{triggered ? "告警" : "正常"}</span>
          </div>
        </Card>
      );
    }
    case "alarmPopup": {
      const alarm = bool(v.alarm);
      return (
        <Card ctx={ctx} className={cn("items-center justify-center gap-1", alarm && "border-danger/60 bg-danger/10")}>
          {title}
          <div className="flex flex-1 items-center justify-center gap-1.5 px-2">
            <BellRing size={16} className={alarm ? "animate-pulse text-danger" : "text-subtle"} />
            <span className={cn("truncate text-[12px]", alarm ? "font-medium text-danger" : "text-subtle")}>{alarm ? str(v.message, "告警！") : "无告警"}</span>
          </div>
        </Card>
      );
    }

    default:
      return (
        <Card ctx={ctx} className="items-center justify-center">
          <span className="text-[11px] text-subtle">未知控件 {widget.type}</span>
        </Card>
      );
  }
}

function ClockWidget({ title }: { title: string }) {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-lg border border-border/60 bg-surface/70 p-1">
      {title && <div className="truncate text-[11px] text-fg/70">{title}</div>}
      <span className="font-mono text-[20px] font-semibold text-fg">
        {now.toLocaleTimeString("zh-CN", { hour12: false })}
      </span>
      <span className="text-[10px] text-subtle">
        {now.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short" })}
      </span>
    </div>
  );
}

export function widgetIcon(type: string): React.ReactNode {
  switch (type) {
    case "button":
    case "toggle":
      return <Zap size={13} />;
    case "slider":
    case "knob":
    case "volumeSlider":
      return <Activity size={13} />;
    case "tempCard":
    case "envCard":
      return <Thermometer size={13} />;
    case "humidityCard":
      return <Droplets size={13} />;
    case "pm25Card":
      return <Wind size={13} />;
    case "gauge":
    case "numberText":
    case "progress":
    case "battery":
      return <GaugeIcon size={13} />;
    case "mediaControls":
    case "songInfo":
      return <Play size={13} />;
    case "lockCard":
    case "doorSensor":
    case "motionSensor":
    case "cameraCard":
      return <Lock size={13} />;
    case "sceneButton":
    case "timerCard":
      return <AlarmClock size={13} />;
    case "lightCard":
      return <Lightbulb size={13} />;
    case "acCard":
      return <Snowflake size={13} />;
    case "curtainCard":
      return <Home size={13} />;
    case "lineChart":
    case "barChart":
      return <Activity size={13} />;
    case "alarmLight":
    case "alarmPopup":
      return <BellRing size={13} />;
    case "logList":
      return <Activity size={13} />;
    case "clockCard":
      return <AlarmClock size={13} />;
    default:
      return <Eye size={13} />;
  }
}
