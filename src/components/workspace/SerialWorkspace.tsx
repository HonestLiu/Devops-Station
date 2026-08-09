import { useEffect, useMemo, useRef, useState } from "react";
import {
  Calculator,
  LineChart,
  RotateCw,
  ScrollText,
  Sparkles,
  TerminalSquare,
  Trash2,
  Zap,
} from "lucide-react";

import { Badge, Button, Select } from "@/components/ui";
import { ConnectionOverlay } from "@/components/ConnectionOverlay";
import { Terminal } from "@/components/terminal/Terminal";
import { TerminalAiButton } from "@/ai/TerminalAiButton";
import { parseSerialProtocol } from "@/ai/tasks";
import { SerialPlot } from "@/components/serial/SerialPlot";
import { SendBar, type SendBarHandle } from "@/components/serial/SendBar";
import { Converter } from "@/components/serial/Converter";
import { useTerminalTheme } from "@/hooks/useTerminalTheme";
import { useHostsStore } from "@/store/useHostsStore";
import { useTabsStore } from "@/store/useTabsStore";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  formatTime,
  hexToBytes,
  unescapeSequences,
  LINE_ENDINGS,
} from "@/lib/utils";
import { serial } from "@/lib/api";
import { useSerialLog } from "@/ai/serialLog";
import type {
  LineEnding,
  QuickCommand,
  SerialEncoding,
  SerialLogEntry,
  SerialViewMode,
  Tab,
} from "@/lib/types";

const MODES: { id: SerialViewMode; label: string; icon: typeof ScrollText }[] = [
  { id: "normal", label: "Normal", icon: ScrollText },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "plot", label: "Plot", icon: LineChart },
];

const ENCODINGS: SerialEncoding[] = ["utf-8", "gbk", "ascii", "hex"];

function decodeBytes(bytes: Uint8Array, enc: SerialEncoding): string {
  if (enc === "hex") return bytesToHex(bytes);
  if (enc === "ascii") {
    return Array.from(bytes).map((b) => (b < 128 ? String.fromCharCode(b) : "?")).join("");
  }
  if (enc === "gbk") {
    try {
      return new TextDecoder("gbk").decode(bytes);
    } catch {
      return new TextDecoder("ascii").decode(bytes);
    }
  }
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

export function SerialWorkspace({ tab }: { tab: Tab }) {
  const t = useTerminalTheme();
  const reconnect = useTabsStore((s) => s.reconnect);
  const allQuick = useHostsStore((s) => s.quickCommands);

  const sessionId = tab.sessionId;
  const connected = tab.status === "connected" && !!sessionId;

  const [mode, setMode] = useState<SerialViewMode>("normal");
  const [encoding, setEncoding] = useState<SerialEncoding>("utf-8");
  const [lineEnding, setLineEnding] = useState<LineEnding>("lf");
  const [logs, setLogs] = useState<SerialLogEntry[]>([]);
  const [showQuick, setShowQuick] = useState(true);
  const [showConverter, setShowConverter] = useState(false);

  const logId = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const encodingRef = useRef(encoding);
  encodingRef.current = encoding;
  const bottomRef = useRef<HTMLDivElement>(null);
  const sendBarRef = useRef<SendBarHandle>(null);

  const quick = useMemo(
    () => allQuick.filter((c) => c.scope === "serial" || c.scope === "both"),
    [allQuick],
  );

  const appendLog = (dir: "rx" | "tx", text: string, hex: string) => {
    setLogs((prev) => {
      const next = [
        ...prev,
        { id: ++logId.current, at: Date.now(), dir, text, hex },
      ];
      if (next.length > 2000) next.shift();
      return next;
    });
  };

  // Receive log only in Normal mode; Plot and Terminal subscribe themselves.
  //
  // Like the terminal, this listener attaches *after* the port is already open,
  // so it asks the backend to flush what it buffered in the meantime. That
  // matters most here: opening a port toggles DTR, which resets many boards —
  // the entire boot log lands in that gap.
  useEffect(() => {
    if (!sessionId || mode !== "normal") return;

    let disposed = false;
    let flushed = false;
    const parked: Uint8Array[] = [];
    let stop: (() => void) | undefined;

    const receive = (bytes: Uint8Array) => {
      const text = decodeBytes(bytes, encodingRef.current);
      appendLog("rx", text, bytesToHex(bytes));
      useSerialLog.getState().push(text);
    };

    void (async () => {
      try {
        const un = await serial.onData(sessionId, (chunk) => {
          if (disposed) return;
          const bytes = base64ToBytes(chunk.data);
          if (!flushed) {
            parked.push(bytes);
            return;
          }
          receive(bytes);
        });
        if (disposed) return void un();
        stop = un;

        const pending = await serial.attach(sessionId);
        if (disposed) return;
        if (pending.backlog) receive(base64ToBytes(pending.backlog));
        flushed = true;
        for (const bytes of parked) receive(bytes);
        parked.length = 0;
      } catch {
        // Port closed before we got here; the overlay reports it.
      }
    })();

    return () => {
      disposed = true;
      stop?.();
    };
  }, [sessionId, mode]);

  // Auto-scroll the log view to the newest entry.
  useEffect(() => {
    if (mode === "normal") bottomRef.current?.scrollIntoView();
  }, [logs, mode]);

  // Normal mode has no terminal to click into, so put the caret in the composer
  // as soon as the port is live — typing should just work, like it does in
  // Terminal mode.
  useEffect(() => {
    if (mode !== "terminal" && connected) sendBarRef.current?.focus();
  }, [mode, connected]);

  const send = (raw: string, asHex: boolean) => {
    if (!sessionId || !raw) return;
    let bytes: Uint8Array;
    if (asHex) {
      bytes = hexToBytes(raw);
    } else {
      const escaped = unescapeSequences(raw);
      const le = LINE_ENDINGS[lineEnding];
      bytes = new TextEncoder().encode(escaped + le);
    }
    void serial.write(sessionId, bytesToBase64(bytes));
    if (mode === "normal") {
      appendLog("tx", asHex ? bytesToHex(bytes) : raw, bytesToHex(bytes));
    }
  };

  const cfg = tab.serial;
  const configLabel = cfg
    ? `${cfg.port} · ${cfg.baudRate} · ${cfg.parity}${cfg.dataBits}${cfg.stopBits}`
    : tab.subtitle;

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Toolbar */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3">
        <div className="flex items-center gap-1 rounded-md border border-border bg-bg p-0.5">
          {MODES.map((m) => {
            const Icon = m.icon;
            const active = mode === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={
                  "flex items-center gap-1.5 rounded px-2 py-1 text-[12px] transition-colors " +
                  (active ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover")
                }
              >
                <Icon size={13} />
                {m.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 no-drag">
          <Badge tone="warning">{configLabel}</Badge>
          <Select
            value={encoding}
            onChange={(e) => setEncoding(e.target.value as SerialEncoding)}
            className="w-24"
            title="Receive encoding"
          >
            {ENCODINGS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
          <Button
            variant={showQuick ? "primary" : "ghost"}
            size="sm"
            onClick={() => setShowQuick((v) => !v)}
            title="Quick commands"
          >
            <Zap size={14} />
          </Button>
          <Button
            variant={showConverter ? "primary" : "ghost"}
            size="sm"
            onClick={() => setShowConverter((v) => !v)}
            title="Converter"
          >
            <Calculator size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLogs([])}
            title="Clear log"
          >
            <Trash2 size={14} />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title="Reconnect">
            <RotateCw size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Analyze recent serial data as a protocol"
            onClick={() => void parseSerialProtocol()}
          >
            <Sparkles size={14} /> Parse
          </Button>
          <TerminalAiButton tab={tab} />
        </div>
      </div>

      {/* Body */}
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {mode === "terminal" && connected && sessionId && (
            <Terminal
              key={sessionId}
              sessionId={sessionId}
              transport="serial"
              theme={t.theme}
              fontFamily={t.fontFamily}
              fontSize={t.fontSize}
              lineHeight={t.lineHeight}
              cursorBlink={t.cursorBlink}
              cursorStyle={t.cursorStyle}
              scrollback={t.scrollback}
            />
          )}
          {mode === "plot" && connected && sessionId && <SerialPlot sessionId={sessionId} />}
          {mode === "normal" && (
            // Clicking the log drops the caret in the composer, so the view
            // behaves like a terminal: click anywhere, start typing.
            <div
              onMouseUp={() => {
                // Don't steal the caret when the click was a text selection.
                if (!window.getSelection()?.toString()) sendBarRef.current?.focus();
              }}
              className="h-full overflow-y-auto py-1 font-mono text-[12px]"
            >
              {logs.map((e) => (
                <div
                  key={e.id}
                  className="border-b border-border/40 px-3 py-1 break-all whitespace-pre-wrap"
                >
                  <span className="mr-2 text-subtle">{formatTime(e.at)}</span>
                  <span className={e.dir === "rx" ? "text-accent" : "text-warning"}>
                    {e.dir === "rx" ? "RX" : "TX"}
                  </span>
                  <span className="ml-2 text-fg">{e.text || "(binary)"}</span>
                  <span className="mt-0.5 block text-[10px] text-subtle">{e.hex}</span>
                </div>
              ))}
              {logs.length === 0 && (
                <p className="p-4 text-center text-[12px] text-subtle">
                  No data yet. Incoming bytes appear here — type below to send.
                </p>
              )}
              <div ref={bottomRef} />
            </div>
          )}
          {tab.status !== "connected" && <ConnectionOverlay tab={tab} />}
        </div>

        {(showQuick || showConverter) && (
          <aside className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-surface p-3">
            {showQuick && (
              <div>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                  Quick Commands
                </h3>
                <div className="space-y-1.5">
                  {quick.length === 0 && (
                    <p className="text-[11px] text-subtle">
                      None yet. Add some in Hosts → Quick Commands.
                    </p>
                  )}
                  {quick.map((c: QuickCommand) => (
                    <button
                      key={c.id}
                      onClick={() => send(c.value, c.isHex)}
                      disabled={!connected}
                      title={connected ? c.value : "Port is not connected"}
                      className="flex w-full items-center justify-between gap-2 rounded border border-border bg-elevated px-2.5 py-1.5 text-left text-[12px] hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-elevated"
                    >
                      <span className="font-medium text-fg">{c.name}</span>
                      <code className="truncate text-[10px] text-subtle">{c.value}</code>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {showConverter && (
              <div>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">
                  Converter
                </h3>
                <Converter />
              </div>
            )}
          </aside>
        )}
      </div>

      {/* Composer (hidden in Terminal mode — xterm captures keystrokes itself) */}
      {mode !== "terminal" && (
        <SendBar
          ref={sendBarRef}
          connected={connected}
          disabledReason={
            tab.status === "connecting"
              ? "Opening the port…"
              : "Port is closed — hit Reconnect to send again."
          }
          lineEnding={lineEnding}
          onLineEndingChange={setLineEnding}
          onSend={send}
        />
      )}
    </div>
  );
}
