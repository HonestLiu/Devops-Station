import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpDown,
  Cable,
  Download,
  Eraser,
  Pause,
  Play,
  Power,
  PowerOff,
  Radio,
  Trash2,
} from "lucide-react";

import { Badge, Button, ModuleHeader, Select } from "@/components/ui";
import { SerialRecordView } from "@/components/serial/SerialRecordView";
import { SendBar, type SendBarHandle } from "@/components/serial/SendBar";
import { QuickSendPanel } from "@/components/serial/QuickSendPanel";
import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  formatTime,
  LINE_ENDINGS,
} from "@/lib/utils";
import { encodeSendData, type SendMeta } from "@/lib/serialCodec";
import { jlink } from "@/lib/api";
import { useJlinkBase } from "./useJlinkBase";
import { JLinkConnectionFields } from "./JLinkConnectionFields";
import { JLinkInstallBanner } from "./JLinkShared";
import type { LineEnding, SerialEncoding, SerialLogEntry } from "@/lib/types";

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

/**
 * RTT 调试 module — restyled as a SerialAssistant clone. The backend runs a
 * J-Link Commander + JLinkRTTClient pair; raw channel-0 bytes arrive as base64
 * chunks and render into the same RX/TX record view, quick-send panel and
 * TEXT/HEX composer the serial workspace uses. Left panel holds the J-Link
 * probe settings + start/stop; bottom status bar counts TX/RX bytes.
 */
export function JLinkRttWorkspace() {
  const t = useT();
  const closeTab = useTabsStore((s) => s.closeTab);
  const { config, setConfig, devices, busy, jlinkPath } = useJlinkBase();

  const [running, setRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [encoding, setEncoding] = useState<SerialEncoding>("utf-8");
  const [lineEnding, setLineEnding] = useState<LineEnding>("lf");
  const [logs, setLogs] = useState<SerialLogEntry[]>([]);
  const [rxHex, setRxHex] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [frozen, setFrozen] = useState(false);
  const [txBytes, setTxBytes] = useState(0);
  const [rxBytes, setRxBytes] = useState(0);

  const logId = useRef(0);
  const encodingRef = useRef(encoding);
  encodingRef.current = encoding;
  const rxHexRef = useRef(rxHex);
  rxHexRef.current = rxHex;
  // Freeze: stop capturing into the visible log while data still buffers.
  const frozenRef = useRef(false);
  frozenRef.current = frozen;
  const pendingRef = useRef<SerialLogEntry[]>([]);
  // utf-8 stream decoder keeps multi-byte chars split across chunks intact.
  const streamDecoderRef = useRef<TextDecoder | null>(null);
  const sendBarRef = useRef<SendBarHandle>(null);

  const appendLog = (dir: "rx" | "tx", text: string, hex: string, rawLen: number) => {
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
    if (dir === "rx") setRxBytes((v) => v + rawLen);
    else setTxBytes((v) => v + rawLen);
  };

  const appendSys = (line: string) => {
    appendLog("rx", `[SYS] ${line}`, "", 0);
  };

  const receiveBytes = (chunk: Uint8Array) => {
    const hex = bytesToHex(chunk);
    let text: string;
    if (encodingRef.current === "utf-8") {
      if (!streamDecoderRef.current) streamDecoderRef.current = new TextDecoder("utf-8");
      text = streamDecoderRef.current.decode(chunk, { stream: true });
    } else {
      text = decodeBytes(chunk, encodingRef.current);
    }
    const displayText = rxHexRef.current ? hex : text;
    appendLog("rx", displayText, hex, chunk.length);
  };

  // Attach to the RTT byte stream + diagnostics while mounted; detach on
  // unmount so a closed tab doesn't leak listeners. Also sync the badge with
  // the backend: closing/reopening the tab doesn't stop a running RTT pair.
  useEffect(() => {
    let alive = true;
    jlink
      .rttRunning()
      .then((v) => alive && setRunning(v))
      .catch(() => {});
    let unData: (() => void) | undefined;
    let unLog: (() => void) | undefined;
    jlink
      .onRttData((b64) => {
        if (!alive) return;
        receiveBytes(base64ToBytes(b64));
      })
      .then((fn) => (unData = fn))
      .catch(() => {});
    jlink
      .onRttLog((line) => appendSys(line))
      .then((fn) => (unLog = fn))
      .catch(() => {});
    return () => {
      alive = false;
      unData?.();
      unLog?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset the utf-8 stream decoder when the encoding changes (its internal
  // partial state is only meaningful while staying on utf-8).
  useEffect(() => {
    if (encoding !== "utf-8") streamDecoderRef.current = null;
  }, [encoding]);

  // Liveness poll while "running": a probe unplug / process death flips the
  // badge back to "未运行" within ~2s.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      jlink
        .rttRunning()
        .then((v) => {
          if (!v) {
            setRunning(false);
            appendSys(t("jlink.rttExited"));
          }
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, [running, t]);

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

  const start = async () => {
    setStarting(true);
    try {
      const res = await jlink.rttStart(config, jlinkPath);
      if (res.success) {
        setRunning(true);
        appendSys(res.output);
      } else {
        appendSys(t("jlink.rttStartFailed"));
        appendSys(res.output);
      }
    } catch (err) {
      appendSys(t("jlink.rttStartFailed"));
      appendSys(String(err));
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    // Flush any partial utf-8 character held by the stream decoder.
    if (streamDecoderRef.current) {
      const tail = streamDecoderRef.current.decode();
      streamDecoderRef.current = null;
      if (tail) appendLog("rx", tail, "", 0);
    }
    try {
      const res = await jlink.rttStop();
      if (res.output) appendSys(res.output);
    } catch (err) {
      appendSys(String(err));
    } finally {
      setRunning(false);
    }
  };

  // Core writer: pushes already-encoded bytes to the RTT channel and records a
  // TX entry. `meta` tells the log how to render the line (text -> raw string,
  // hex/dec -> hex).
  const writeOut = (bytes: Uint8Array, meta: SendMeta) => {
    if (!running || bytes.length === 0) return;
    void jlink.rttSend(bytesToBase64(bytes)).catch((err) => appendSys(String(err)));
    const hex = bytesToHex(bytes);
    const displayText = meta.format === "text" ? meta.raw : hex;
    appendLog("tx", displayText, hex, bytes.length);
  };

  // Byte-based send — used by the SendBar composer.
  const send = (bytes: Uint8Array, meta: SendMeta) => writeOut(bytes, meta);

  // String-based send — used by the QuickSendPanel (plain text or raw hex items).
  const sendRaw = (raw: string, asHex: boolean) => {
    if (!running || !raw.trim()) return;
    const r = encodeSendData({
      raw,
      format: asHex ? "hex" : "text",
      lineEnding: LINE_ENDINGS[lineEnding],
      checksum: "none",
    });
    if (r.bytes) writeOut(r.bytes, { format: asHex ? "hex" : "text", raw, checksum: "none" });
  };

  const exportLog = () => {
    const lines = logs.map((e) => `[${formatTime(e.at)}] ${e.dir.toUpperCase()} ${e.text}`);
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jlink-rtt-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      {/* Top toolbar — shared J-Link module chrome */}
      <ModuleHeader
        icon={<Radio size={15} />}
        title={t("jlink.rtt")}
        badges={
          <Badge tone={running ? "success" : "neutral"}>
            {running ? t("jlink.running") : t("jlink.notRunning")}
          </Badge>
        }
        actions={
          <Select
            value={encoding}
            onChange={(e) => setEncoding(e.target.value as SerialEncoding)}
            className="w-24"
            title={t("ws.receiveEncoding")}
          >
            {ENCODINGS.map((enc) => (
              <option key={enc} value={enc}>
                {enc}
              </option>
            ))}
          </Select>
        }
      />
      <JLinkInstallBanner />

      {/* Main body: left settings + center display + right quick send */}
      <div className="relative flex min-h-0 flex-1">
        {/* Left: J-Link probe settings + start/stop */}
        <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
          <div className="flex h-9 items-center border-b border-border px-3 text-[12px] font-semibold text-fg">
            {t("jlink.connection")}
          </div>
          <div className="flex flex-col gap-3 p-3 text-[12px]">
            <JLinkConnectionFields config={config} setConfig={setConfig} devices={devices} />

            <div className="my-1 h-px bg-border" />

            <Button
              variant={running ? "danger" : "primary"}
              size="sm"
              onClick={() => void (running ? stop() : start())}
              disabled={starting || busy}
              className="w-full"
            >
              {running ? <PowerOff size={14} /> : <Power size={14} />}
              {running
                ? t("jlink.stop")
                : starting
                  ? t("jlink.starting")
                  : t("jlink.start")}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => void closeTab(useTabsStore.getState().activeId!)}
              className="mt-auto w-full"
            >
              <Trash2 size={14} /> 关闭标签
            </Button>
          </div>
        </aside>

        {/* Center: display area */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* Display toolbar */}
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
                onClick={exportLog}
                disabled={logs.length === 0}
                title={t("ws.exportTitle")}
              >
                <Download size={13} /> 导出
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLogs([]);
                  pendingRef.current = [];
                }}
                title={t("ws.clearTitle")}
              >
                <Eraser size={13} /> 清屏
              </Button>
            </div>
          </div>

          {/* Display content */}
          <div className="relative flex-1">
            <SerialRecordView
              logs={logs}
              rxHex={rxHex}
              autoScroll={autoScroll}
              emptyText={t("jlink.rttNoData")}
            />
          </div>
        </div>

        {/* Right: quick send panel */}
        <QuickSendPanel connected={running} onSend={sendRaw} />
      </div>

      {/* Bottom composer + status bar */}
      <div className="shrink-0 border-t border-border bg-surface">
        <SendBar
          ref={sendBarRef}
          connected={running}
          disabledReason={t("jlink.rttDisconnected")}
          lineEnding={lineEnding}
          onLineEndingChange={setLineEnding}
          onSend={send}
        />
        <div className="flex h-7 items-center justify-between gap-3 border-t border-border px-3 text-[11px] text-subtle">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Cable size={12} />
              {config.device} · {config.iface} · {config.speed ? `${config.speed} kHz` : t("jlink.auto")}
            </span>
            <span className={running ? "text-success" : "text-warning"}>
              {running ? t("jlink.rttStarted") : t("jlink.rttStopped")}
            </span>
          </div>
          <div className="flex items-center gap-3 font-mono">
            <span>{t("ws.txBytes", { n: txBytes })}</span>
            <span>{t("ws.rxBytes", { n: rxBytes })}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
