import { useMemo, useState } from "react";

import { useProtocolDesignerStore } from "@/store/useProtocolDesignerStore";
import { useT } from "@/i18n";
import { Select } from "@/components/ui";
import type { ParsedFrame } from "@/lib/types";

/**
 * P3 waveform view: plot a selected numeric field's decoded value across the
 * most recent frames (loopback or live). Pure SVG sparkline — no chart lib.
 * Reply frames (auto-answer) are excluded so the trend reflects real input.
 */
export function WaveChart({ frames }: { frames: ParsedFrame[] }) {
  const t = useT();
  const draftFields = useProtocolDesignerStore((s) => s.draft.fields);

  // Candidate fields: numeric types from the draft, in declaration order.
  const candidates = useMemo(
    () =>
      draftFields
        .filter((f) =>
          [
            "uint8",
            "int16",
            "uint16",
            "int32",
            "uint32",
            "float32",
            "float64",
          ].includes(f.dataType),
        )
        .map((f) => f.name),
    [draftFields],
  );

  const [field, setField] = useState<string>("");
  const active = field || candidates[0] || "";

  // Build the series from the most recent N non-reply frames (oldest → newest).
  const series = useMemo(() => {
    if (!active) return [];
    const src = frames.filter((f) => !(f.isReply ?? false)).slice(0, 120).reverse();
    const out: { v: number }[] = [];
    for (const fr of src) {
      const pf = fr.fields.find((x) => x.name === active);
      if (!pf) continue;
      const v = typeof pf.value === "number" ? pf.value : Number(pf.value);
      if (Number.isFinite(v)) out.push({ v });
    }
    return out;
  }, [frames, active]);

  if (candidates.length === 0 || series.length < 2) return null;

  const W = 320;
  const H = 64;
  const pad = 4;
  const vals = series.map((p) => p.v);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const stepX = (W - pad * 2) / Math.max(1, series.length - 1);
  const points = series
    .map((p, i) => {
      const x = pad + i * stepX;
      const y = H - pad - ((p.v - min) / span) * (H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = vals[vals.length - 1];

  return (
    <div className="mb-3 rounded-lg border border-border bg-bg p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-subtle">
          {t("protocol.waveform")} · {active} = {last}
          {min !== max ? `  (${min}–${max})` : ""}
        </span>
        <Select
          className="h-6 w-32 text-[11px]"
          value={active}
          onChange={(e) => setField(e.target.value)}
        >
          {candidates.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" height={H}>
        <polyline
          points={points}
          fill="none"
          stroke="rgb(var(--c-accent))"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}
