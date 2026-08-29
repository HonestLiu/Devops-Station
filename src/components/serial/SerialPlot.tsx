import { useEffect, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  Clock,
  Pause,
  Play,
  RotateCcw,
  Timer,
  Trash2,
} from "lucide-react";

import { Select } from "@/components/ui";

import { dataLink, type LinkKind } from "@/lib/dataLink";
import { base64ToBytes } from "@/lib/utils";
import { cssColor } from "@/lib/themes";

const MAX_POINT_OPTIONS = [120, 240, 480, 1000, 5000];
const CHANNEL_COLORS = ["accent", "success", "warning", "info", "danger", "purple", "teal", "pink"] as const;
/** Safety cap for a line fragment that never gets a newline (flush it anyway). */
const MAX_LINE_BUFFER = 8192;

interface ParsedLine {
  /** Plain numeric columns without a key, e.g. "1,2,3" or "12.3". */
  numeric: number[];
  /** Keyed values, e.g. "temp:24 hum:63". */
  keyed: Record<string, number>;
  /** The raw line text, kept for the hover tooltip. */
  raw: string;
}

function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const keyed: Record<string, number> = {};
  const numeric: number[] = [];

  // Key-value pairs: key:value or key=value, separated by whitespace or commas.
  const kvRegex = /([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g;
  let kvMatch: RegExpExecArray | null;
  let hasKv = false;
  while ((kvMatch = kvRegex.exec(trimmed)) !== null) {
    keyed[kvMatch[1]] = Number(kvMatch[2]);
    hasKv = true;
  }

  // If no key-value pairs, fall back to comma/whitespace separated numbers.
  if (!hasKv) {
    const parts = trimmed.split(/[,\s]+/).filter(Boolean);
    for (const p of parts) {
      const n = Number(p);
      if (Number.isFinite(n)) numeric.push(n);
    }
  }

  if (numeric.length === 0 && Object.keys(keyed).length === 0) return null;
  return { numeric, keyed, raw: trimmed };
}

function formatClock(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

/**
 * Live time-series plotter for serial data, parity-ported from SerialAssistant's
 * PlotterPanel (uPlot wrapper) with the full UX control set:
 *   pause · clear · follow (auto-scroll) · time mode (elapsed ↔ wall clock) ·
 *   max-points select · legend toggle · hover tooltip · wheel zoom · drag pan.
 *
 * Supports the formats common in embedded debugging:
 *   - a single number: 12.3
 *   - comma separated: 1,2,3
 *   - whitespace separated: 1 2 3
 *   - key-value pairs: temp:24 hum:63  or  temp=24,hum=63
 *
 * Channels are discovered dynamically; the plot is recreated whenever a new key
 * appears. X values are always stored as absolute epoch seconds so switching the
 * time mode never corrupts already-captured history.
 */
export function SerialPlot({
  sessionId,
  kind = "serial",
}: {
  sessionId: string;
  kind?: LinkKind;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const channelsRef = useRef<string[]>([]);
  const dataRef = useRef<number[][]>([[]]); // [x(epoch sec), ch0, ch1, ...]
  const rawRef = useRef<string[]>([]); // raw line per x index
  const startRef = useRef<number>(0); // first sample wall-clock ms (for relative axis)
  const lineBufferRef = useRef(""); // reassembles lines split across serial chunks
  const rebuildRef = useRef<() => void>(() => {});
  const clearRef = useRef<() => void>(() => {});
  const [hasData, setHasData] = useState(false);

  // --- plotter controls (mirrored into refs so the long-lived data closure sees them) ---
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const [autoScroll, setAutoScroll] = useState(true);
  const autoScrollRef = useRef(true);
  autoScrollRef.current = autoScroll;
  const [timeMode, setTimeMode] = useState<"relative" | "absolute">("relative");
  const timeModeRef = useRef<"relative" | "absolute">("relative");
  timeModeRef.current = timeMode;
  const [maxPoints, setMaxPoints] = useState(240);
  const maxPointsRef = useRef(240);
  maxPointsRef.current = maxPoints;
  const [showLegend, setShowLegend] = useState(true);
  const showLegendRef = useRef(true);
  showLegendRef.current = showLegend;
  const [pointCount, setPointCount] = useState(0);

  const [tooltip, setTooltip] = useState<{
    left: number;
    top: number;
    clock: string;
    raw: string;
    values: { name: string; value: number }[];
  } | null>(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    // Build the X axis value formatter for the current time mode (read live via ref).
    const xValues = (_u: uPlot, vals: (number | string)[]) =>
      vals.map((v) =>
        timeModeRef.current === "absolute"
          ? formatClock(v as number)
          : `${((v as number) - startRef.current / 1000).toFixed(2).replace(/\.?0+$/, "")}s`,
      );

    const ensureChannels = (names: string[]) => {
      let changed = false;
      for (const name of names) {
        if (!channelsRef.current.includes(name)) {
          channelsRef.current.push(name);
          // Backfill the new channel with NaN for every point captured so far.
          // Without this a mid-stream channel is shorter than the x-axis data,
          // which corrupts uPlot alignment and crashes the tooltip (undefined).
          dataRef.current.push(new Array(dataRef.current[0].length).fill(NaN));
          changed = true;
        }
      }
      return changed;
    };

    const buildPlot = () => {
      plotRef.current?.destroy();
      const w = host.clientWidth || 600;
      const h = host.clientHeight || 300;
      const series: uPlot.Series[] = [{}];
      for (let i = 0; i < channelsRef.current.length; i++) {
        const color = CHANNEL_COLORS[i % CHANNEL_COLORS.length];
        series.push({
          label: channelsRef.current[i],
          stroke: cssColor(color),
          width: 1.5,
        });
      }
      const opts: uPlot.Options = {
        width: w,
        height: h,
        legend: { show: showLegendRef.current },
        cursor: { points: { show: false }, drag: { x: false, y: false } },
        scales: { x: { time: timeModeRef.current === "absolute" } },
        axes: [
          {
            stroke: cssColor("subtle"),
            grid: { stroke: cssColor("border", 0.5) },
            ticks: { stroke: cssColor("border", 0.5) },
            values: xValues,
          },
          {
            stroke: cssColor("subtle"),
            grid: { stroke: cssColor("border", 0.5) },
            ticks: { stroke: cssColor("border", 0.5) },
          },
        ],
        series,
      };
      // Guard the uPlot construction: a hiccup here must leave plotRef null so
      // the next ingest tries again, instead of crashing the whole workspace.
      try {
        plotRef.current = new uPlot(opts, dataRef.current as unknown as uPlot.AlignedData, host);
        setPointCount(dataRef.current[0].length);
      } catch (e) {
        plotRef.current = null;
        console.error("[SerialPlot] uPlot create failed", e);
      }
    };
    rebuildRef.current = buildPlot;

    const clearPlot = () => {
      channelsRef.current = [];
      dataRef.current = [[]];
      rawRef.current = [];
      startRef.current = 0;
      setHasData(false);
      setPointCount(0);
      buildPlot();
    };
    clearRef.current = clearPlot;

    const ingest = (bytes: Uint8Array) => {
      if (pausedRef.current) return;
      let text: string;
      try {
        text = new TextDecoder("utf-8").decode(bytes);
      } catch {
        text = "";
      }
      // Reassemble lines split across chunks so a partial "temp=24,hu" + "m=63"
      // never parses as two fragments (which would create a spurious "m" channel).
      // An over-long buffer (no newline ever seen) is force-flushed so a stream
      // that doesn't terminate lines can't grow unbounded.
      const pending = lineBufferRef.current + text;
      if (pending.length > MAX_LINE_BUFFER) {
        // Force a flush: treat everything up to the last newline as lines, keep
        // the trailing fragment as the new buffer.
        const flushed = pending.split(/\r?\n/);
        lineBufferRef.current = flushed.pop() ?? "";
        for (const ln of flushed) processLine(ln);
        return;
      }
      const parts = pending.split(/\r?\n/);
      lineBufferRef.current = parts.pop() ?? "";
      for (const ln of parts) processLine(ln);
    };

    const processLine = (rawLine: string) => {
      try {
        const parsed = parseLine(rawLine.trim());
        if (!parsed) return;

        const required: string[] = Object.keys(parsed.keyed);
        if (parsed.numeric.length > 0) {
          for (let i = 0; i < parsed.numeric.length; i++) required.push(`CH${i + 1}`);
        }
        const needRebuild = ensureChannels(required);
        if (!hasData) setHasData(true);

        if (!startRef.current) startRef.current = Date.now();
        const x = Date.now() / 1000; // absolute epoch seconds
        const d = dataRef.current;
        d[0].push(x);
        rawRef.current.push(parsed.raw);
        for (let i = 0; i < channelsRef.current.length; i++) {
          const key = channelsRef.current[i];
          let val: number;
          if (key.startsWith("CH")) {
            const idx = Number(key.slice(2)) - 1;
            val = parsed.numeric[idx] ?? NaN;
          } else {
            val = parsed.keyed[key] ?? NaN;
          }
          d[i + 1].push(val);
        }

        // Trim only while following the latest; otherwise keep the whole history
        // so the user can scroll/zoom back through it.
        if (autoScrollRef.current && d[0].length > maxPointsRef.current) {
          const drop = d[0].length - maxPointsRef.current;
          for (let i = 0; i < d.length; i++) d[i].splice(0, drop);
          rawRef.current.splice(0, drop);
        }

        if (needRebuild || !plotRef.current) {
          try {
            buildPlot();
          } catch (e) {
            console.error("[SerialPlot] rebuild failed", e);
          }
        } else {
          try {
            plotRef.current.setData(dataRef.current as unknown as uPlot.AlignedData);
          } catch (e) {
            console.error("[SerialPlot] setData failed", e);
          }
        }
        setPointCount(d[0].length);
      } catch (e) {
        // A single malformed line must never stop the live stream.
        console.error("[SerialPlot] processLine failed", rawLine, e);
      }
    };

    let unSub: (() => void) | undefined;
    const un = dataLink(kind).onData(sessionId, (chunk) => ingest(base64ToBytes(chunk.data)));
    un.then((fn) => {
      unSub = fn;
    });

    const ro = new ResizeObserver(() => {
      const p = plotRef.current;
      if (!p || !host) return;
      p.setSize({ width: host.clientWidth, height: host.clientHeight });
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      unSub?.();
      plotRef.current?.destroy();
      plotRef.current = null;
    };
    // Only re-subscribe when the session changes; control changes are handled via
    // refs (live values) and the rebuild/tooltip effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, kind]);

  // Rebuild the chart when a control that changes uPlot options changes.
  useEffect(() => {
    try {
      rebuildRef.current();
    } catch (e) {
      console.error("[SerialPlot] rebuild failed", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeMode, showLegend]);

  // --- tooltip + zoom/pan (mouse) --------------------------------------------
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const onMove = (e: MouseEvent) => {
      const p = plotRef.current;
      if (!p) return;
      const rect = p.rect;
      const left = e.clientX - rect.left;
      const top = e.clientY - rect.top;
      if (left < 0 || left > rect.width || top < 0 || top > rect.height) {
        setTooltip(null);
        return;
      }
      const idx = p.posToIdx(left);
      const xData = dataRef.current[0];
      if (idx < 0 || idx >= xData.length) {
        setTooltip(null);
        return;
      }
      const pointLeft = p.valToPos(xData[idx], "x");
      if (Math.abs(pointLeft - left) > 14) {
        setTooltip(null);
        return;
      }
      const values: { name: string; value: number }[] = [];
      for (let i = 0; i < channelsRef.current.length; i++) {
        const v = dataRef.current[i + 1][idx];
        // NaN/undefined/out-of-range channel data must never reach the tooltip.
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        values.push({ name: channelsRef.current[i], value: v });
      }
      if (values.length === 0) {
        setTooltip(null);
        return;
      }
      const xv = xData[idx];
      setTooltip({
        left: left + 14,
        top: top + 14,
        clock: timeMode === "absolute" ? formatClock(xv) : `${(xv - startRef.current / 1000).toFixed(3)}s`,
        raw: rawRef.current[idx] ?? "",
        values,
      });
    };

    const onLeave = () => setTooltip(null);

    const onWheel = (e: WheelEvent) => {
      const p = plotRef.current;
      if (!p || dataRef.current[0].length < 2) return;
      e.preventDefault();
      setAutoScroll(false);
      const mouseLeft = Math.min(Math.max(e.clientX - p.rect.left, 0), p.rect.width);
      const center = p.posToVal(mouseLeft, "x");
      const scale = p.scales.x;
      const curMin = Number(scale.min);
      const curMax = Number(scale.max);
      if (!Number.isFinite(center) || !Number.isFinite(curMin) || !Number.isFinite(curMax)) return;
      const zoom = e.deltaY < 0 ? 0.8 : 1.25;
      const leftSpan = Math.max(center - curMin, 1e-4);
      const rightSpan = Math.max(curMax - center, 1e-4);
      let nextMin = center - leftSpan * zoom;
      let nextMax = center + rightSpan * zoom;
      const xData = dataRef.current[0];
      const dataMin = xData[0];
      const dataMax = xData[xData.length - 1];
      if (e.deltaY > 0) {
        if (nextMin < dataMin) nextMin = dataMin;
        if (nextMax > dataMax) nextMax = dataMax;
      }
      p.setScale("x", { min: nextMin, max: nextMax });
    };

    let drag: { startX: number; min: number; max: number; width: number } | null = null;
    const onDragMove = (e: MouseEvent) => {
      const p = plotRef.current;
      if (!p || !drag) return;
      setAutoScroll(false);
      const dx = e.clientX - drag.startX;
      const span = drag.max - drag.min;
      const shift = (-dx * span) / Math.max(drag.width, 1);
      p.setScale("x", { min: drag.min + shift, max: drag.max + shift });
    };
    const onDragUp = () => {
      drag = null;
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragUp);
    };
    const onDown = (e: MouseEvent) => {
      const p = plotRef.current;
      if (e.button !== 0 || !p || dataRef.current[0].length < 2) return;
      const scale = p.scales.x;
      drag = {
        startX: e.clientX,
        min: Number(scale.min),
        max: Number(scale.max),
        width: p.rect.width,
      };
      window.addEventListener("mousemove", onDragMove);
      window.addEventListener("mouseup", onDragUp);
    };

    host.addEventListener("mousemove", onMove);
    host.addEventListener("mouseleave", onLeave);
    host.addEventListener("wheel", onWheel, { passive: false });
    host.addEventListener("mousedown", onDown);
    return () => {
      host.removeEventListener("mousemove", onMove);
      host.removeEventListener("mouseleave", onLeave);
      host.removeEventListener("wheel", onWheel);
      host.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onDragMove);
      window.removeEventListener("mouseup", onDragUp);
    };
  }, [timeMode]);

  const toolbarBtn =
    "flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors text-muted hover:bg-hover";
  const cnActive = (active: boolean, activeCls: string) =>
    toolbarBtn + " " + (active ? activeCls : "text-muted hover:bg-hover");

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      {/* Plotter toolbar */}
      <div className="flex h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-surface px-2">
        <button
          onClick={() => setPaused((v) => !v)}
          className={cnActive(paused, "bg-warning text-warning-fg")}
          title={paused ? "继续绘图" : "暂停绘图"}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? "继续" : "暂停"}
        </button>
        <button onClick={() => clearRef.current()} className={toolbarBtn} title="清空绘图">
          <Trash2 size={13} /> 清空
        </button>
        <button
          onClick={() => setAutoScroll((v) => !v)}
          className={cnActive(autoScroll, "bg-accent text-accent-fg")}
          title="自动滚动到最新数据"
        >
          <RotateCcw size={13} /> 跟随
        </button>
        <button
          onClick={() => setTimeMode((m) => (m === "absolute" ? "relative" : "absolute"))}
          className={toolbarBtn}
          title={timeMode === "absolute" ? "切换为相对时间" : "切换为真实时间"}
        >
          {timeMode === "absolute" ? <Clock size={13} /> : <Timer size={13} />}
          {timeMode === "absolute" ? "真实时间" : "相对时间"}
        </button>
        <button
          onClick={() => setShowLegend((v) => !v)}
          className={cnActive(showLegend, "bg-accent text-accent-fg")}
          title="切换图例"
        >
          图例
        </button>
        <Select
          value={maxPoints}
          onChange={(e) => setMaxPoints(Number(e.target.value))}
          title="最大点数（跟随模式下的滚动窗口）"
          className="ml-1 h-7 rounded border border-border bg-bg px-1 text-[11px] text-fg"
        >
          {MAX_POINT_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {o} 点
            </option>
          ))}
        </Select>
        <span className="ml-auto font-mono text-[10px] text-subtle">{pointCount} pts</span>
      </div>

      {/* Plot area */}
      <div className="serial-plot relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0 cursor-grab active:cursor-grabbing" />
        {tooltip && (
          <div
            className="pointer-events-none absolute z-10 max-w-[260px] rounded-md border border-border bg-surface px-3 py-2 text-[11px] text-fg shadow-md"
            style={{ left: tooltip.left, top: tooltip.top }}
          >
            <div className="font-semibold">{tooltip.clock}</div>
            {tooltip.raw && <div className="mt-1 break-all text-subtle">{tooltip.raw}</div>}
            <div className="mt-2 grid gap-1">
              {tooltip.values.map((v) => (
                <div key={v.name} className="flex items-center justify-between gap-4 tabular-nums">
                  <span>{v.name}</span>
                  <span>
                    {Number.isFinite(v.value)
                      ? Number.isInteger(v.value)
                        ? v.value
                        : v.value.toFixed(3)
                      : "—"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-subtle">
            <LineChartIcon />
            <p className="text-[14px] font-medium">等待数字数据…</p>
            <div className="text-center text-[12px] leading-relaxed">
              <p>每段串口数据识别为一组，格式可以是：</p>
              <p className="mt-1 font-mono">一个数：12.3</p>
              <p className="font-mono">逗号分隔：1,2,3</p>
              <p className="font-mono">空格分隔：1 2 3</p>
              <p className="font-mono">键值对：temp:24 hum:63</p>
              <p className="font-mono">键值对：temp=24,hum=63</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function LineChartIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40">
      <path d="M3 3v18h18" />
      <path d="M19 17l-4-4-3 3-4-7-3 4" />
    </svg>
  );
}
