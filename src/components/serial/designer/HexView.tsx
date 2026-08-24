import { useMemo } from "react";

import { bytesToAscii, base64ToBytes } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface HighlightSpan {
  start: number;
  end: number; // exclusive
  key: string; // field name → used for selected highlight
}

/**
 * Compact hexadecimal dump with optional byte-range highlighting. Two-column
 * layout: hex bytes + ASCII gutter. `highlights` map field names to byte spans,
 * and clicking a byte reports its span's key via `onSelect`. The `activeKey`
 * (e.g. the field currently selected in the parse table) gets a stronger ring.
 *
 * `raw` is base64 (matches the backend's wire format).
 */
export function HexView({
  raw,
  highlights = [],
  activeKey,
  onSelect,
  className,
}: {
  raw: string;
  highlights?: HighlightSpan[];
  activeKey?: string | null;
  onSelect?: (key: string | null) => void;
  className?: string;
}) {
  const bytes = useMemo(() => {
    try {
      return base64ToBytes(raw);
    } catch {
      return new Uint8Array();
    }
  }, [raw]);

  const ascii = useMemo(() => bytesToAscii(bytes), [bytes]);

  // Bucket byte indices by highlight key so we can color/group them.
  const keyAt = (i: number): string | null => {
    for (const h of highlights) {
      if (i >= h.start && i < h.end) return h.key;
    }
    return null;
  };

  if (bytes.length === 0) {
    return (
      <div className={cn("rounded-lg border border-border bg-bg px-3 py-4 text-center text-[12px] text-subtle", className)}>
        —
      </div>
    );
  }

  const rows: number[][] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    rows.push(Array.from(bytes.slice(i, i + 16)));
  }

  return (
    <div
      className={cn(
        "overflow-auto rounded-lg border border-border bg-bg font-mono text-[12px] leading-relaxed",
        className,
      )}
    >
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((row, r) => {
            const base = r * 16;
            return (
              <tr key={r}>
                <td className="select-none border-r border-border/60 px-2 py-0.5 text-right text-subtle">
                  {base.toString(16).padStart(4, "0").toUpperCase()}
                </td>
                {row.map((b, c) => {
                  const idx = base + c;
                  const key = keyAt(idx);
                  const selected = key != null && key === activeKey;
                  return (
                    <td
                      key={c}
                      onClick={() => key && onSelect?.(key)}
                      className={cn(
                        "cursor-default px-1 text-center",
                        key
                          ? selected
                            ? "rounded bg-accent text-accent-fg"
                            : "rounded bg-accent/15 text-accent"
                          : "text-fg",
                      )}
                    >
                      {b.toString(16).padStart(2, "0").toUpperCase()}
                    </td>
                  );
                })}
                {/* pad short final row */}
                {row.length < 16 &&
                  Array.from({ length: 16 - row.length }).map((_, c) => (
                    <td key={`pad-${c}`} className="px-1 text-center text-subtle">
                      ·
                    </td>
                  ))}
                <td className="border-l border-border/60 px-2 py-0.5 text-subtle">
                  {ascii.slice(base, base + 16)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
