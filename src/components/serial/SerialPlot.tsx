import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { serial } from "@/lib/api";
import { base64ToBytes } from "@/lib/utils";
import { cssColor } from "@/lib/themes";

const MAX_POINTS = 240;
const CHANNELS = 4;

const CHANNEL_COLORS = ["accent", "success", "warning", "info"] as const;

/** Parse a line into up to CHANNELS floats (CSV / whitespace separated). */
function parseLine(line: string): number[] | null {
  const parts = line.split(/[,\s]+/).filter(Boolean);
  const nums = parts.map((p) => Number(p)).filter((n) => Number.isFinite(n));
  if (nums.length === 0) return null;
  while (nums.length < CHANNELS) nums.push(NaN);
  return nums.slice(0, CHANNELS);
}

/**
 * Live time-series plotter for serial data. Each incoming line is split into
 * numeric columns and appended as a sample. Up to 4 channels are supported;
 * uPlot is recreated only on first real data (to learn the series count) and
 * thereafter updated in place for performance.
 */
export function SerialPlot({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dataRef = useRef<number[][]>([[], [], [], [], []]); // [x, c0..c3]
  const startRef = useRef<number>(0);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const mkPlot = () => {
      const w = host.clientWidth || 600;
      const h = host.clientHeight || 300;
      const series: uPlot.Series[] = [{}];
      for (let i = 0; i < CHANNELS; i++) {
        series.push({
          label: `CH${i + 1}`,
          stroke: cssColor(CHANNEL_COLORS[i]),
          width: 1.5,
        });
      }
      const opts: uPlot.Options = {
        width: w,
        height: h,
        scales: { x: { time: false } },
        legend: { show: true },
        cursor: { points: { show: false } },
        axes: [
          {
            stroke: cssColor("subtle"),
            grid: { stroke: cssColor("border", 0.5) },
            ticks: { stroke: cssColor("border", 0.5) },
          },
          {
            stroke: cssColor("subtle"),
            grid: { stroke: cssColor("border", 0.5) },
            ticks: { stroke: cssColor("border", 0.5) },
          },
        ],
        series,
      };
      plotRef.current = new uPlot(opts, dataRef.current as unknown as uPlot.AlignedData, host);
    };

    mkPlot();

    const ingest = (bytes: Uint8Array) => {
      let text: string;
      try {
        text = new TextDecoder("utf-8").decode(bytes);
      } catch {
        text = "";
      }
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        const nums = parseLine(line.trim());
        if (!nums) continue;
        if (!startRef.current) startRef.current = Date.now();
        const x = Date.now() - startRef.current;
        const d = dataRef.current;
        d[0].push(x);
        for (let i = 0; i < CHANNELS; i++) d[i + 1].push(nums[i]);
        if (d[0].length > MAX_POINTS) {
          for (let i = 0; i <= CHANNELS; i++) d[i].shift();
        }
      }
      if (plotRef.current) {
        plotRef.current.setData(dataRef.current as unknown as uPlot.AlignedData);
      }
    };

    let unSub: (() => void) | undefined;
    const un = serial.onData(sessionId, (chunk) => ingest(base64ToBytes(chunk.data)));
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
  }, [sessionId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
