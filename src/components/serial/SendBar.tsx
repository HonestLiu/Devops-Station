import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { CornerDownLeft, Send } from "lucide-react";

import { Button, Select } from "@/components/ui";
import { cn, bytesToHex, hexToBytes, unescapeSequences, LINE_ENDINGS } from "@/lib/utils";
import type { LineEnding } from "@/lib/types";

const LINE_ENDING_OPTS: { id: LineEnding; label: string }[] = [
  { id: "none", label: "No EOL" },
  { id: "cr", label: "CR" },
  { id: "lf", label: "LF" },
  { id: "crlf", label: "CRLF" },
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
  onSend: (raw: string, asHex: boolean) => void;
}

interface Encoded {
  bytes?: Uint8Array;
  error?: string;
  warning?: string;
}

/**
 * The composer for Normal (and Plot) mode.
 *
 * Normal mode is the view people use when a board speaks a binary protocol, so
 * the old text-only field was a real hole: you could only send hex by saving a
 * Quick Command first. This adds a TEXT/HEX switch, shows exactly which bytes
 * are about to hit the wire, and keeps a history so you can re-fire the last
 * command with Up instead of retyping it.
 */
export const SendBar = forwardRef<SendBarHandle, SendBarProps>(function SendBar(
  { connected, disabledReason, lineEnding, onLineEndingChange, onSend },
  ref,
) {
  const [value, setValue] = useState("");
  const [isHex, setIsHex] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  // -1 means "composing a new line"; otherwise an index into `history`.
  const [cursor, setCursor] = useState(-1);
  const draft = useRef("");
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  // What actually goes out on the wire, so you can eyeball it before sending.
  const encoded = useMemo<Encoded>(() => {
    if (!value) return {};
    if (isHex) {
      const digits = value.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
      if (!digits) return { error: "No hex digits" };
      const stray = value.replace(/0x/gi, "").replace(/[0-9a-fA-F\s,]/g, "");
      const bytes = hexToBytes(value);
      // hexToBytes right-pads a trailing half-byte, which silently changes the
      // value (`ABC` becomes AB C0). Say so rather than let it surprise you.
      const warning =
        digits.length % 2 === 1
          ? `Odd digit count — last byte padded to ${bytesToHex(bytes.subarray(bytes.length - 1))}`
          : stray
            ? `Ignoring non-hex characters: ${stray.slice(0, 12)}`
            : undefined;
      return { bytes, warning };
    }
    const text = unescapeSequences(value) + LINE_ENDINGS[lineEnding];
    return { bytes: new TextEncoder().encode(text) };
  }, [value, isHex, lineEnding]);

  const canSend = connected && !!encoded.bytes?.length && !encoded.error;

  const submit = () => {
    if (!canSend) return;
    onSend(value, isHex);
    setHistory((prev) => {
      // Collapse an immediate repeat so Up isn't full of duplicates.
      const next = prev[0] === value ? prev : [value, ...prev];
      return next.slice(0, HISTORY_LIMIT);
    });
    setCursor(-1);
    draft.current = "";
    setValue("");
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
    // Put the caret at the end rather than wherever it happened to be.
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

  return (
    <div className="shrink-0 border-t border-border bg-surface">
      <div className="flex items-center gap-2 px-3 pb-1.5 pt-2">
        {/* TEXT / HEX */}
        <div className="flex shrink-0 items-center rounded border border-border bg-bg p-0.5">
          {([false, true] as const).map((hex) => (
            <button
              key={String(hex)}
              onClick={() => setIsHex(hex)}
              title={hex ? "Send raw bytes written as hex" : "Send text (\\r \\n \\t \\xNN expand)"}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] font-semibold tracking-wide transition-colors",
                isHex === hex ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover",
              )}
            >
              {hex ? "HEX" : "TEXT"}
            </button>
          ))}
        </div>

        <Select
          value={lineEnding}
          onChange={(e) => onLineEndingChange(e.target.value as LineEnding)}
          className="w-24 shrink-0"
          title={isHex ? "Line endings don't apply to raw hex" : "Appended to every line you send"}
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
              ? "AA 55 01 FF — spaces and 0x are optional"
              : "Type a command… \\r \\n \\t \\xNN for control bytes · ↑ for history"
          }
          className={cn(
            "select-text h-8 min-w-0 flex-1 rounded border bg-bg px-2.5 font-mono text-[12px] text-fg",
            "placeholder:text-subtle focus:outline-none focus:ring-1",
            encoded.error
              ? "border-danger focus:border-danger focus:ring-danger/40"
              : "border-border focus:border-accent focus:ring-accent/40",
          )}
        />

        <Button variant="primary" size="sm" onClick={submit} disabled={!canSend} className="shrink-0">
          <Send size={13} /> Send
        </Button>
      </div>

      {/* Status line: why you can't send, what's wrong, or what's about to go out. */}
      <div className="flex h-[18px] items-center gap-2 px-3 pb-1.5 font-mono text-[10px]">
        <StatusLine
          connected={connected}
          disabledReason={disabledReason}
          encoded={encoded}
          empty={!value}
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
}: {
  connected: boolean;
  disabledReason?: string;
  encoded: Encoded;
  empty: boolean;
}) {
  if (!connected) {
    return (
      <span className="text-danger">
        {disabledReason ?? "Not connected — reconnect the port to send."}
      </span>
    );
  }
  if (encoded.error) return <span className="text-danger">{encoded.error}</span>;
  if (empty) {
    return (
      <span className="flex items-center gap-1 text-subtle">
        <CornerDownLeft size={10} />
        Enter sends · ↑ / ↓ history
      </span>
    );
  }

  const bytes = encoded.bytes ?? new Uint8Array();
  const head = bytes.subarray(0, PREVIEW_BYTES);
  const elided = bytes.length > PREVIEW_BYTES;

  return (
    <>
      <span className="shrink-0 text-subtle">
        {bytes.length} byte{bytes.length === 1 ? "" : "s"}
      </span>
      <span className="truncate text-muted">
        {bytesToHex(head)}
        {elided ? " …" : ""}
      </span>
      {encoded.warning && (
        <span className="ml-auto shrink-0 text-warning">{encoded.warning}</span>
      )}
    </>
  );
}
