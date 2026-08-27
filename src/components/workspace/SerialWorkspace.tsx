import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Activity,
  ArrowUpDown,
  Cable,
  Check,
  Eraser,
  FileOutput,
  FileUp,
  LineChart,
  Loader2,
  Pause,
  Play,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  ScrollText,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";

import { Badge, Button, Select } from "@/components/ui";
import { ConnectionOverlay } from "@/components/ConnectionOverlay";
import { Terminal } from "@/components/terminal/Terminal";
import { TerminalInlineAsk } from "@/ai/TerminalInlineAsk";
import { getTerminal, getTerminalText } from "@/ai/terminalBridge";
import { parseSerialProtocol } from "@/ai/tasks";
import { SerialPlot } from "@/components/serial/SerialPlot";
import { SendBar, type SendBarHandle } from "@/components/serial/SendBar";
import { SerialRecordView } from "@/components/serial/SerialRecordView";
import { QuickSendPanel } from "@/components/serial/QuickSendPanel";
import { useTerminalTheme } from "@/hooks/useTerminalTheme";
import { useT, type TKey } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  formatTime,
  LINE_ENDINGS,
} from "@/lib/utils";
import { serial, localFs } from "@/lib/api";
import { dataLink, type DataLink, type LinkKind } from "@/lib/dataLink";
import { shortUuid } from "@/lib/bleGatt";
import { useSerialLog } from "@/ai/serialLog";
import { encodeSendData, type SendMeta } from "@/lib/serialCodec";
import type {
  LineEnding,
  SerialEncoding,
  SerialLogEntry,
  SerialViewMode,
  Tab,
} from "@/lib/types";

const MODES: { id: SerialViewMode; labelKey: TKey; icon: typeof ScrollText }[] = [
  { id: "normal", labelKey: "ws.modeData", icon: ScrollText },
  { id: "plot", labelKey: "ws.modePlot", icon: LineChart },
  { id: "terminal", labelKey: "ws.modeTerminal", icon: TerminalSquare },
];

const ENCODINGS: SerialEncoding[] = ["utf-8", "gbk", "ascii", "hex"];

/** Safety cap for an RX line fragment that never receives a newline. */
const MAX_RX_LINE_BUFFER = 64 * 1024;

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
  const tt = useTerminalTheme();
  const t = useT();
  const reconnect = useTabsStore((s) => s.reconnect);
  const closeTab = useTabsStore((s) => s.closeTab);
  const patch = useTabsStore((s) => s.patch);

  const isBle = tab.kind === "ble";
  const link: DataLink = dataLink((isBle ? "ble" : "serial") as LinkKind);

  const sessionId = tab.sessionId;
  const connected = tab.status === "connected" && !!sessionId;

  const [mode, setMode] = useState<SerialViewMode>("normal");
  const [encoding, setEncoding] = useState<SerialEncoding>("utf-8");
  const [lineEnding, setLineEnding] = useState<LineEnding>("lf");
  const [logs, setLogs] = useState<SerialLogEntry[]>([]);
  const [rxHex, setRxHex] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [txBytes, setTxBytes] = useState(0);
  const [rxBytes, setRxBytes] = useState(0);
  // Export button feedback: "idle" | "busy" (spinner) | "ok" (check) | "err".
  const [exportState, setExportState] = useState<"idle" | "busy" | "ok" | "err">("idle");

  const logId = useRef(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const encodingRef = useRef(encoding);
  encodingRef.current = encoding;
  const rxHexRef = useRef(rxHex);
  rxHexRef.current = rxHex;
  // Freeze: stop capturing into the visible log while data still buffers upstream.
  // Kept in a ref so the (long-lived) receive closure sees the live value.
  const frozenRef = useRef(false);
  frozenRef.current = frozen;
  const pendingRef = useRef<SerialLogEntry[]>([]);
  const sendBarRef = useRef<SendBarHandle>(null);
  // RX line buffer: reassembles a device line that arrives split across serial
  // reads, so "temp:31,hum=32" is one log entry even when the first byte
  // arrives in its own read.
  const rxBufRef = useRef<Uint8Array>(new Uint8Array(0));

  const appendLog = (dir: "rx" | "tx", text: string, hex: string) => {
    const entry: SerialLogEntry = { id: ++logId.current, at: Date.now(), dir, text, hex };
    if (frozenRef.current) {
      pendingRef.current.push(entry);
      if (pendingRef.current.length > 2000) pendingRef.current.shift();
    } else {
      setLogs((prev) => {
        const next = [...prev, entry];
        if (next.length > 2000) next.shift();
        return next;
      });
    }
  };

  const toggleFreeze = () => {
    setFrozen((f) => {
      const next = !f;
      if (!next) {
        // Resuming: flush anything buffered while frozen into the visible log.
        if (pendingRef.current.length) {
          setLogs((prev) => {
            const nextLogs = [...prev, ...pendingRef.current];
            pendingRef.current = [];
            if (nextLogs.length > 2000) nextLogs.splice(0, nextLogs.length - 2000);
            return nextLogs;
          });
        }
      }
      return next;
    });
  };

  useEffect(() => {
    if (!sessionId || mode !== "normal") return;

    let disposed = false;
    let flushed = false;
    const parked: Uint8Array[] = [];
    let stop: (() => void) | undefined;

    // Emit one log entry for a complete RX line. A trailing CR is stripped so
    // CRLF lines don't carry a dangling "\r" into the displayed text.
    const flushLine = (lineBytes: Uint8Array) => {
      const end =
        lineBytes.length > 0 && lineBytes[lineBytes.length - 1] === 0x0d
          ? lineBytes.length - 1
          : lineBytes.length;
      const line = lineBytes.slice(0, end);
      if (line.length === 0) return;
      const text = decodeBytes(line, encodingRef.current);
      const hex = bytesToHex(line);
      const displayText = rxHexRef.current ? hex : text;
      appendLog("rx", displayText, hex);
      useSerialLog.getState().push(text);
    };

    const receive = (bytes: Uint8Array) => {
      // Coalesce reads into whole lines: a device line split across reads (e.g.
      // "t" then "emp:31,hum=32") must appear as ONE entry, not two.
      const merged = new Uint8Array(rxBufRef.current.length + bytes.length);
      merged.set(rxBufRef.current, 0);
      merged.set(bytes, rxBufRef.current.length);

      // Split at the last line terminator (\n or \r) so the tail stays buffered.
      let lastSep = -1;
      for (let i = 0; i < merged.length; i++) {
        if (merged[i] === 0x0a || merged[i] === 0x0d) lastSep = i;
      }

      if (lastSep < 0) {
        // No complete line yet — keep buffering (with a safety cap).
        if (merged.length > MAX_RX_LINE_BUFFER) {
          flushLine(merged);
          rxBufRef.current = new Uint8Array(0);
        } else {
          rxBufRef.current = merged;
        }
        setRxBytes((v) => v + bytes.length);
        return;
      }

      // Emit one entry per terminator-separated segment; "\r\n" counts once.
      const complete = merged.slice(0, lastSep + 1);
      rxBufRef.current = merged.slice(lastSep + 1);
      let start = 0;
      let i = 0;
      while (i < complete.length) {
        const b = complete[i];
        if (b === 0x0a || b === 0x0d) {
          flushLine(complete.slice(start, i));
          if (b === 0x0d && i + 1 < complete.length && complete[i + 1] === 0x0a) i++;
          start = i + 1;
        }
        i++;
      }
      setRxBytes((v) => v + bytes.length);
    };

    void (async () => {
      try {
        const un = await link.onData(sessionId, (chunk) => {
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

        const pending = await link.attach(sessionId);
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
      // Flush a trailing partial RX line so a mode switch never drops it.
      if (rxBufRef.current.length > 0) {
        flushLine(rxBufRef.current);
        rxBufRef.current = new Uint8Array(0);
      }
    };
  }, [sessionId, mode]);

  useEffect(() => {
    if (mode !== "terminal" && connected) sendBarRef.current?.focus();
  }, [mode, connected]);

  // When the backend reports the serial session closed (user disconnect, device
  // unplugged, or port error), reflect it in the tab so the button flips back to
  // "打开串口" and the disconnected overlay appears.
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void link.onClosed(sessionId, (info) => {
      if (disposed) return;
      // Don't surface a clean user disconnect as an error message.
      const isUserClose = info.reason === "closed by user";
      patch(tab.id, {
        status: "closed",
        sessionId: undefined,
        error: isUserClose ? undefined : info.reason,
      });
    }).then((un) => {
      if (disposed) un();
      else stop = un;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [sessionId, tab.id, patch]);

  // Core writer: pushes already-encoded bytes to the port and records a TX entry.
  // `meta` tells the log how to render the line (text -> raw string, hex/dec -> hex).
  const writeOut = (bytes: Uint8Array, meta: SendMeta) => {
    if (!sessionId || bytes.length === 0) return;
    void link.write(sessionId, bytesToBase64(bytes));
    if (mode === "normal") {
      const hex = bytesToHex(bytes);
      const displayText = meta.format === "text" ? meta.raw : hex;
      appendLog("tx", displayText, hex);
    }
    setTxBytes((v) => v + bytes.length);
  };

  // Byte-based send — used by the SendBar composer (format + checksum resolved upstream).
  const send = (bytes: Uint8Array, meta: SendMeta) => writeOut(bytes, meta);

  // String-based send — used by the QuickSendPanel (plain text or raw hex items).
  const sendRaw = (raw: string, asHex: boolean) => {
    if (!sessionId || !raw.trim()) return;
    const r = encodeSendData({
      raw,
      format: asHex ? "hex" : "text",
      lineEnding: LINE_ENDINGS[lineEnding],
      checksum: "none",
    });
    if (r.bytes) writeOut(r.bytes, { format: asHex ? "hex" : "text", raw, checksum: "none" });
  };

  const exportLog = async () => {
    if (exportState === "busy") return;
    // Terminal mode: the data-mode log list is empty, so export the xterm
    // scrollback instead.
    const content =
      mode === "terminal"
        ? (sessionId ? getTerminalText(sessionId) : "")
        : logs.map((e) => `[${formatTime(e.at)}] ${e.dir.toUpperCase()} ${e.text}`).join("\n");
    if (!content) return;

    const base = mode === "terminal" ? "serial-terminal" : "serial-log";
    const picked = await save({
      title: "导出串口日志",
      defaultPath: `${base}-${tab.title}-${Date.now()}.txt`,
      filters: [{ name: "文本文件", extensions: ["txt"] }],
    });
    if (!picked) return; // user canceled — keep idle state

    setExportState("busy");
    try {
      await localFs.writeText(picked, content);
      setExportState("ok");
      window.setTimeout(() => setExportState("idle"), 1500);
    } catch (e) {
      console.error("[SerialWorkspace] export failed", e);
      setExportState("err");
      window.setTimeout(() => setExportState("idle"), 1500);
    }
  };

  const cfg = tab.serial;
  const bleCfg = tab.ble;
  const configLabel = isBle
    ? bleCfg
      ? `${bleCfg.deviceName ?? bleCfg.deviceId} · ${shortUuid(bleCfg.service)}`
      : tab.subtitle
    : cfg
      ? `${cfg.port} · ${cfg.baudRate} · ${cfg.parity}/${cfg.dataBits}/${cfg.stopBits}`
      : tab.subtitle;

  const toggleConnect = () => {
    if (connected) {
      if (sessionId) {
        void link.close(sessionId);
        // Optimistic update — flip the UI immediately so the button responds even
        // before the backend's `*-closed` event arrives.
        patch(tab.id, { status: "closed", sessionId: undefined, error: undefined });
      }
    } else {
      void reconnect(tab.id);
    }
  };

  const dtrRts = (dtr?: boolean, rts?: boolean) => {
    // DTR/RTS are serial-line control signals — BLE has no equivalent, so the
    // buttons are hidden and this is guarded as a belt-and-braces measure.
    if (sessionId && !isBle) void serial.signals(sessionId, dtr, rts);
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Top toolbar */}
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
                {t(m.labelKey)}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 no-drag">
          <Badge tone={connected ? "success" : tab.status === "error" ? "danger" : "warning"}>
            {connected ? t("ws.statusConnected") : tab.status === "error" ? t("ws.statusError") : tab.status === "connecting" ? t("ws.statusConnecting") : t("ws.statusWaiting")}
          </Badge>
          {mode === "normal" && (
            <Select
              value={encoding}
              onChange={(e) => setEncoding(e.target.value as SerialEncoding)}
              className="w-24"
              title={t("ws.receiveEncoding")}
            >
              {ENCODINGS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>
          )}
          <Button variant="ghost" size="sm" onClick={() => void reconnect(tab.id)} title={t("common.reconnect")}>
            <RotateCw size={14} />
          </Button>
          {mode !== "plot" && (
            <Button
              variant="ghost"
              size="sm"
              title={t("ws.protocolParseTitle")}
              onClick={() => void parseSerialProtocol()}
            >
              协议解析
            </Button>
          )}
        </div>
      </div>

      {/* Main body: left settings + center display + right quick send */}
      <div className="relative flex min-h-0 flex-1">
        {/* Left: transport settings panel (serial or BLE) */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
          <div className="flex h-9 items-center border-b border-border px-3 text-[12px] font-semibold text-fg">
            {isBle ? t("ws.bleSettings") : t("ws.serialSettings")}
          </div>
          <div className="flex flex-col gap-3 p-3 text-[12px]">
            {isBle ? (
              <>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.device")}</span>
                  <span className="font-mono text-fg">{bleCfg?.deviceName ?? bleCfg?.deviceId ?? "—"}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.serviceUuid")}</span>
                  <span className="font-mono text-fg break-all">{bleCfg ? shortUuid(bleCfg.service) : "—"}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.writeChar")}</span>
                  <span className="font-mono text-fg break-all">{bleCfg ? shortUuid(bleCfg.writeCharacteristic) : "—"}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.notifyChar")}</span>
                  <span className="font-mono text-fg break-all">
                    {bleCfg?.notifyCharacteristic ? shortUuid(bleCfg.notifyCharacteristic) : "无（仅发送）"}
                  </span>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.port")}</span>
                  <span className="font-mono text-fg">{cfg?.port ?? "—"}</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.baud")}</span>
                    <span className="text-fg">{cfg?.baudRate ?? "—"}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.dataBits")}</span>
                    <span className="text-fg">{cfg?.dataBits ?? "—"}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.parity")}</span>
                    <span className="text-fg">{cfg?.parity ?? "—"}</span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.stopBits")}</span>
                    <span className="text-fg">{cfg?.stopBits ?? "—"}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[11px] uppercase tracking-wide text-subtle"> {t("ws.flow")}</span>
                  <span className="text-fg">{cfg?.flowControl ?? "—"}</span>
                </div>
              </>
            )}

            <div className="my-1 h-px bg-border" />

            <Button
              variant={connected ? "danger" : "primary"}
              size="sm"
              onClick={toggleConnect}
              disabled={tab.status === "connecting"}
              className="w-full"
            >
              {connected ? <PowerOff size={14} /> : <Power size={14} />}
              {connected
                ? t("ws.disconnect")
                : tab.status === "connecting"
                  ? t("common.connecting")
                  : isBle
                    ? t("ws.connectBle")
                    : t("ws.openSerial")}
            </Button>

            {!isBle && (
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" size="sm" onClick={() => dtrRts(true)} disabled={!connected}>
                  DTR
                </Button>
                <Button variant="secondary" size="sm" onClick={() => dtrRts(undefined, true)} disabled={!connected}>
                  RTS
                </Button>
              </div>
            )}

            <Button variant="ghost" size="sm" onClick={() => void closeTab(tab.id)} className="mt-auto w-full">
              <Trash2 size={14} /> 关闭标签
            </Button>
          </div>
        </aside>

        {/* Center: display area */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* Display toolbar. Hidden in plot mode — the plot has its own toolbar
              (pause / follow / clear / time / legend). */}
          {mode !== "plot" && (
            <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setRxHex((v) => !v)}
                  className={
                    "flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors " +
                    (rxHex ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover")
                  }
                  title={t("ws.receiveHex")}
                >
                  <Activity size={12} /> 接收:HEX
                </button>
                {mode === "normal" && (
                  <button
                    onClick={() => setAutoScroll((v) => !v)}
                    className={
                      "flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors " +
                      (autoScroll ? "bg-accent text-accent-fg" : "text-muted hover:bg-hover")
                    }
                    title={t("ws.autoScroll")}
                  >
                    <ArrowUpDown size={12} /> 自动滚动
                  </button>
                )}
                <button
                  onClick={toggleFreeze}
                  className={
                    "flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors " +
                    (frozen ? "bg-warning text-warning-fg" : "text-muted hover:bg-hover")
                  }
                  title={t("ws.pauseTitle")}
                >
                  {frozen ? <Play size={12} /> : <Pause size={12} />}
                  {frozen ? t("ws.paused") : t("ws.pause")}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void exportLog()}
                  disabled={
                    exportState === "busy" ||
                    (mode === "normal" ? logs.length === 0 : !sessionId)
                  }
                  title={t("ws.exportTitle")}
                >
                  {exportState === "busy" ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : exportState === "ok" ? (
                    <Check size={13} className="text-success" />
                  ) : exportState === "err" ? (
                    <X size={13} className="text-danger" />
                  ) : (
                    <FileOutput size={13} />
                  )}
                  导出
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" disabled title={t("ws.sendFileTitle")}>
                  <FileUp size={13} /> 发送文件
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setLogs([]);
                    pendingRef.current = [];
                    if (sessionId) getTerminal(sessionId)?.clear();
                  }}
                  title={t("ws.clearTitle")}
                >
                  <Eraser size={13} /> 清屏
                </Button>
              </div>
            </div>
          )}

          {/* Display content */}
          <div className="relative min-h-0 flex-1">
            {mode === "terminal" && connected && sessionId && (
              <div className="flex h-full min-h-0 flex-col">
                <div className="relative min-h-0 flex-1">
                  <Terminal
                    key={sessionId}
                    sessionId={sessionId}
                    transport={isBle ? "ble" : "serial"}
                    paused={frozen}
                    rxHex={rxHex}
                    theme={tt.theme}
                    fontFamily={tt.fontFamily}
                    fontSize={tt.fontSize}
                    lineHeight={tt.lineHeight}
                    cursorBlink={tt.cursorBlink}
                    cursorStyle={tt.cursorStyle}
                    scrollback={tt.scrollback}
                  />
                </div>
                <TerminalInlineAsk tab={tab} />
              </div>
            )}
            {mode === "plot" && connected && sessionId && (
              <SerialPlot sessionId={sessionId} kind={isBle ? "ble" : "serial"} />
            )}
            {mode === "normal" && (
              <SerialRecordView logs={logs} rxHex={rxHex} autoScroll={autoScroll} />
            )}
            {tab.status !== "connected" && <ConnectionOverlay tab={tab} />}
          </div>
        </div>

        {/* Right: quick send panel */}
        <QuickSendPanel connected={connected} onSend={sendRaw} />
      </div>

      {/* Bottom composer + status bar */}
      {mode !== "terminal" && (
        <div className="shrink-0 border-t border-border bg-surface">
          <SendBar
            ref={sendBarRef}
            connected={connected}
            disabledReason={
              tab.status === "connecting"
                ? isBle
                  ? "正在连接蓝牙…"
                  : t("ws.connectingSerial")
                : isBle
                  ? t("ws.disconnectedBle")
                  : t("ws.disconnectedSerial")
            }
            lineEnding={lineEnding}
            onLineEndingChange={setLineEnding}
            onSend={send}
          />
          <div className="flex h-7 items-center justify-between gap-3 border-t border-border px-3 text-[11px] text-subtle">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <Cable size={12} />
                {configLabel}
              </span>
              <span className={connected ? "text-success" : "text-warning"}>
                {connected ? t("ws.statusConnected") : t("ws.statusDisconnected")}
              </span>
            </div>
            <div className="flex items-center gap-3 font-mono">
              <span>{t("ws.txBytes", { n: txBytes })}</span>
              <span>{t("ws.rxBytes", { n: rxBytes })}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
