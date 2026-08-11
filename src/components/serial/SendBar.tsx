import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { CornerDownLeft, Repeat, Send, Square, Wand2 } from "lucide-react";

import { Button, Input, Select } from "@/components/ui";
import { cn, bytesToHex, LINE_ENDINGS } from "@/lib/utils";
import type { LineEnding } from "@/lib/types";
import {
  CHECKSUM_ALGOS,
  encodeSendData,
  reformatHex,
  type ChecksumAlgo,
  type SendFormat,
  type SendMeta,
} from "@/lib/serialCodec";

const LINE_ENDING_OPTS: { id: LineEnding; label: string }[] = [
  { id: "none", label: "No EOL" },
  { id: "cr", label: "CR" },
  { id: "lf", label: "LF" },
  { id: "crlf", label: "CRLF" },
];

const FORMAT_OPTS: { id: SendFormat; label: string; title: string }[] = [
  { id: "text", label: "TEXT", title: "文本（\\r \\n \\t \\xNN 转义，附行尾）" },
  { id: "hex", label: "HEX", title: "十六进制字节（可自动追加校验位）" },
  { id: "dec", label: "DEC", title: "十进制数（空格分隔，每个数转成最小字节）" },
];

/** Longest run of bytes rendered in the wire preview before it gets elided. */
const PREVIEW_BYTES = 16;
const HISTORY_LIMIT = 100;

export interface SendBarHandle {
  focus: () => void;
}

interface SendBarProps {
  connected: boolean;
  /** Shown in place of the byte preview when sending isn't possible. */
  disabledReason?: string;
  lineEnding: LineEnding;
  onLineEndingChange: (value: LineEnding) => void;
  /** Wire bytes + a description of how they were produced. */
  onSend: (bytes: Uint8Array, meta: SendMeta) => void;
}

// --- tiny localStorage persistence (no external dep needed) ----------------
function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function savePref<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

/**
 * The composer for Normal (and Plot) mode, parity-ported from SerialAssistant.
 *
 * Upgrades the old text-only field with the full sending toolkit:
 *  - TEXT / HEX / DEC format switch (DEC mirrors the original `dec` send type)
 *  - trailing checksum select (校验和 / 奇偶校验 / 异或校验 / ModbusCRC16), HEX only
 *  - HEX 重整 (Ctrl/Cmd+S) normalizes spacing and pads odd nibbles
 *  - 循环发送 (auto-send) on a configurable millisecond interval
 *  - ↑/↓ history, and a live preview of exactly which bytes hit the wire
 */
export const SendBar = forwardRef<SendBarHandle, SendBarProps>(function SendBar(
  { connected, disabledReason, lineEnding, onLineEndingChange, onSend },
  ref,
) {
  const [value, setValue] = useState("");
  const [format, setFormat] = useState<SendFormat>(() =>
    loadPref<SendFormat>("serial.sendFormat", "text"),
  );
  const [checksum, setChecksum] = useState<ChecksumAlgo>(() =>
    loadPref<ChecksumAlgo>("serial.checksum", "none"),
  );
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const draft = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);

  const isHex = format === "hex";
  const [autoSendMs, setAutoSendMs] = useState<number>(() =>
    loadPref<number>("serial.autoSendMs", 1000),
  );
  const [autoSending, setAutoSending] = useState(false);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  useEffect(() => savePref("serial.sendFormat", format), [format]);
  useEffect(() => savePref("serial.checksum", checksum), [checksum]);
  useEffect(() => savePref("serial.autoSendMs", autoSendMs), [autoSendMs]);

  // What actually goes out on the wire, so you can eyeball it before sending.
  const encoded = useMemo(() => {
    if (!value.trim()) return {} as ReturnType<typeof encodeSendData>;
    return encodeSendData({
      raw: value,
      format,
      lineEnding: LINE_ENDINGS[lineEnding],
      checksum,
    });
  }, [value, format, lineEnding, checksum]);

  const canSend = connected && !!encoded.bytes?.length && !encoded.error;

  // Keep the latest onSend reachable from the interval without re-subscribing.
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  const sendNow = (keepValue: boolean) => {
    if (!canSend || !encoded.bytes) return;
    onSendRef.current(encoded.bytes, {
      format,
      raw: value,
      checksum,
    });
    setHistory((prev) => {
      const next = prev[0] === value ? prev : [value, ...prev];
      return next.slice(0, HISTORY_LIMIT);
    });
    setCursor(-1);
    draft.current = "";
    if (!keepValue) setValue("");
  };

  // Auto-send loop: resend the current field on a fixed interval.
  useEffect(() => {
    if (!autoSending || !connected) return;
    const id = window.setInterval(() => {
      const r = encodeSendData({
        raw: value,
        format,
        lineEnding: LINE_ENDINGS[lineEnding],
        checksum,
      });
      if (r.bytes && !r.error) {
        onSendRef.current(r.bytes, { format, raw: value, checksum });
      }
    }, Math.max(10, autoSendMs));
    return () => window.clearInterval(id);
  }, [autoSending, connected, value, format, lineEnding, checksum, autoSendMs]);

  // Stop auto-send the moment we lose the connection.
  useEffect(() => {
    if (!connected) setAutoSending(false);
  }, [connected]);

  const toggleAuto = () => {
    if (!connected) return;
    setAutoSending((v) => !v);
  };

  const submit = () => sendNow(false);

  const reformat = () => {
    if (isHex) setValue((v) => reformatHex(v));
  };

  /** Up/Down walk the history, stashing the in-progress line on the way out. */
  const step = (delta: 1 | -1) => {
    if (history.length === 0) return;
    const next = cursor + delta;
    if (next < -1) return;
    if (next >= history.length) return;
    if (cursor === -1 && delta === 1) draft.current = value;
    setCursor(next);
    setValue(next === -1 ? draft.current : history[next]);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      reformat();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      step(1);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      step(-1);
    }
  };

  const previewBytes = encoded.bytes ?? new Uint8Array();
  const previewHead = previewBytes.subarray(0, PREVIEW_BYTES);
  const previewElided = previewBytes.length > PREVIEW_BYTES;

  return (
    <div className="shrink-0 border-t border-border bg-surface">
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2">
        {/* TEXT / HEX / DEC */}
        <div className="flex shrink-0 items-center rounded border border-border bg-bg p-0.5">
          {FORMAT_OPTS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFormat(f.id)}
              title={f.title}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide transition-colors",
                format === f.id ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <Select
          value={lineEnding}
          onChange={(e) => onLineEndingChange(e.target.value as LineEnding)}
          className="w-24 shrink-0"
          title={isHex ? "行尾对原始 HEX 不生效" : "每条发送内容后追加的行尾符"}
          disabled={isHex}
        >
          {LINE_ENDING_OPTS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>

        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setCursor(-1);
          }}
          onKeyDown={onKeyDown}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            isHex
              ? "AA 55 01 FF — 空格、0x、逗号均可；Ctrl/Cmd+S 重整"
              : format === "dec"
                ? "255 256 1000 — 十进制数，空格分隔"
                : "输入命令… \\r \\n \\t \\xNN 转义 · ↑ 历史"
          }
          className={cn(
            "select-text h-8 min-w-0 flex-1 rounded border bg-bg px-2.5 font-mono text-[12px] text-fg",
            "placeholder:text-subtle focus:outline-none focus:ring-1",
            encoded.error
              ? "border-danger focus:border-danger focus:ring-danger/40"
              : "border-border focus:border-accent focus:ring-accent/40",
          )}
        />

        {isHex && (
          <Select
            value={checksum}
            onChange={(e) => setChecksum(e.target.value as ChecksumAlgo)}
            className="w-28 shrink-0"
            title="在 HEX 帧尾追加校验位"
          >
            <option value="none">无校验</option>
            {CHECKSUM_ALGOS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        )}

        {isHex && (
          <Button
            variant="ghost"
            size="sm"
            onClick={reformat}
            disabled={!value.trim()}
            title="重整十六进制（Ctrl/Cmd+S）"
            className="shrink-0"
          >
            <Wand2 size={13} /> 重整
          </Button>
        )}

        {/* 循环发送 (auto-send) */}
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={autoSending ? "danger" : "secondary"}
            size="sm"
            onClick={toggleAuto}
            disabled={!connected}
            title="按固定间隔重复发送"
            className="shrink-0"
          >
            {autoSending ? <Square size={13} /> : <Repeat size={13} />}
            {autoSending ? "停止" : "循环"}
          </Button>
          {autoSending && (
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={10}
                step={50}
                value={autoSendMs}
                onChange={(e) => setAutoSendMs(Math.max(10, Number(e.target.value)))}
                className="h-7 w-16 px-1 text-center text-[11px]"
                title="自动发送间隔（毫秒）"
              />
              <span className="text-[10px] text-subtle">ms</span>
            </div>
          )}
        </div>

        <Button variant="primary" size="sm" onClick={submit} disabled={!canSend} className="shrink-0">
          <Send size={13} /> 发送
        </Button>
      </div>

      {/* Status line: why you can't send, what's wrong, or what's about to go out. */}
      <div className="flex h-[18px] items-center gap-2 px-3 pb-1.5 font-mono text-[10px]">
        <StatusLine
          connected={connected}
          disabledReason={disabledReason}
          encoded={encoded}
          empty={!value.trim()}
          previewBytes={previewHead}
          previewElided={previewElided}
          totalBytes={previewBytes.length}
        />
      </div>
    </div>
  );
});

function StatusLine({
  connected,
  disabledReason,
  encoded,
  empty,
  previewBytes,
  previewElided,
  totalBytes,
}: {
  connected: boolean;
  disabledReason?: string;
  encoded: Partial<ReturnType<typeof encodeSendData>>;
  empty: boolean;
  previewBytes: Uint8Array;
  previewElided: boolean;
  totalBytes: number;
}) {
  if (!connected) {
    return (
      <span className="text-danger">
        {disabledReason ?? "未连接 — 请先打开串口再发送。"}
      </span>
    );
  }
  if (encoded.error) return <span className="text-danger">{encoded.error}</span>;
  if (empty) {
    return (
      <span className="flex items-center gap-1 text-subtle">
        <CornerDownLeft size={10} />
        Enter 发送 · ↑/↓ 历史 · 循环发送可定时重发
      </span>
    );
  }

  return (
    <>
      <span className="shrink-0 text-subtle">{totalBytes} 字节</span>
      {encoded.checksumBytes && encoded.checksumBytes.length > 0 && (
        <span className="shrink-0 text-info">
          校验[{bytesToHex(encoded.checksumBytes)}]
        </span>
      )}
      <span className="truncate text-muted">
        {bytesToHex(previewBytes)}
        {previewElided ? " …" : ""}
      </span>
      {encoded.warning && (
        <span className="ml-auto shrink-0 text-warning">{encoded.warning}</span>
      )}
    </>
  );
}
