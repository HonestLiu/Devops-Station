import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Eye, EyeOff, Pause, Play, Search } from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { SerialLogEntry } from "@/lib/types";

interface SerialRecordViewProps {
  logs: SerialLogEntry[];
  /** When true, RX entries render hex instead of decoded text by default. */
  rxHex: boolean;
  /** Workspace-controlled: stop the view from following the newest entry. */
  autoScroll: boolean;
  /** Copy helper from the browser clipboard. */
  onCopy?: (text: string) => void;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

function formatStamp(at: number, full: boolean): string {
  const d = new Date(at);
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const ms = pad(d.getMilliseconds(), 3);
  if (!full) return `${hms}.${ms}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}.${ms}`;
}

/**
 * Normal-mode record panel, parity-ported from SerialAssistant's RecordList.
 *
 * Each row is a bubble (RX hugs the left, TX the right) with:
 *  - click the timestamp to toggle HH:mm:ss:SSS <-> full date
 *  - click the body to flip that row between decoded text and hex
 *  - a copy button (appears on hover) for the displayed content
 *  - a byte count
 * A search box filters by either representation; a freeze toggle pauses capture
 * upstream so the view stays put while data keeps flowing into the buffer.
 */
export function SerialRecordView({
  logs,
  rxHex,
  autoScroll,
  onCopy,
}: SerialRecordViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [fullTime, setFullTime] = useState(false);
  // Per-row override of the default (rxHex) display; absence means "use default".
  const [hexOverride, setHexOverride] = useState<Record<number, boolean>>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter(
      (e) => e.text.toLowerCase().includes(q) || e.hex.toLowerCase().includes(q),
    );
  }, [logs, query]);

  // Follow the newest entry unless the user turned auto-scroll off.
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filtered, autoScroll]);

  const copy = (text: string) => {
    if (!text) return;
    if (onCopy) onCopy(text);
    else navigator.clipboard?.writeText(text).catch(() => {});
  };

  return (
    <div className="flex h-full flex-col">
      {/* Search sub-bar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search size={12} className="pointer-events-none absolute left-2 text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="过滤接收/发送内容…"
            spellCheck={false}
            className="h-6 w-full rounded border border-border bg-bg pl-7 pr-2 font-mono text-[11px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
        <span className="shrink-0 text-[10px] tabular-nums text-subtle">
          {filtered.length}/{logs.length}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="h-full flex-1 overflow-y-auto py-1 font-mono text-[12px]"
      >
        {filtered.map((e) => {
          const showHex = hexOverride[e.id] ?? rxHex;
          const content = showHex ? e.hex : e.text || "(binary)";
          const isRx = e.dir === "rx";
          return (
            <div
              key={e.id}
              className={cn(
                "group flex flex-col gap-0.5 border-b border-border/30 px-3 py-1 break-all",
                isRx ? "items-start" : "items-end",
              )}
            >
              <div className="flex w-full items-center gap-2 text-[10px] text-subtle">
                <button
                  onClick={() => setFullTime((v) => !v)}
                  title="点击切换时间格式"
                  className="hover:text-fg"
                >
                  {formatStamp(e.at, fullTime)}
                </button>
                <span
                  className={cn(
                    "rounded px-1 font-semibold",
                    isRx ? "bg-accent/15 text-accent" : "bg-warning/15 text-warning",
                  )}
                >
                  {isRx ? "RX" : "TX"}
                </span>
                <span className="tabular-nums">{Math.ceil(e.hex.length / 2)} B</span>
                <div className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={() => setHexOverride((m) => ({ ...m, [e.id]: !showHex }))}
                    title={showHex ? "切换为文本" : "切换为 HEX"}
                    className="hover:text-fg"
                  >
                    {showHex ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                  <button onClick={() => copy(content)} title="复制" className="hover:text-fg">
                    <Copy size={11} />
                  </button>
                </div>
              </div>
              <div
                onClick={() => setHexOverride((m) => ({ ...m, [e.id]: !showHex }))}
                className={cn(
                  "max-w-full cursor-pointer whitespace-pre-wrap rounded px-2 py-1",
                  isRx
                    ? "bg-accent/5 text-accent"
                    : "bg-warning/5 text-warning",
                )}
              >
                {content}
              </div>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <p className="p-4 text-center text-[12px] text-subtle">
            {logs.length === 0
              ? "暂无接收记录。连接串口后数据将显示在这里，在下方输入内容即可发送。"
              : "没有匹配的内容。"}
          </p>
        )}
      </div>
    </div>
  );
}
