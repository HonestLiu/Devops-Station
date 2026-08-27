import { useEffect, useRef, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Eraser, MemoryStick, Power, Unplug, Upload, Zap } from "lucide-react";

import { Button, Field, Input, ModuleHeader } from "@/components/ui";
import { jlink } from "@/lib/api";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { useJlinkBase } from "./useJlinkBase";
import { useJlinkStore } from "@/store/useJlinkStore";
import { JLinkConnectionFields } from "./JLinkConnectionFields";
import {
  HexDump,
  JLinkCard,
  JLinkInstallBanner,
  JLinkLogPanel,
  JLinkResultCard,
  JLinkStatusHeader,
  parseMemOutput,
  type JLinkLastResult,
} from "./JLinkShared";

/**
 * Flash 下载 module — the probe connection controls plus memory read/write
 * and firmware programming. Split out of the old monolithic J-Link page into
 * its own module tab.
 *
 * UI shape (top → bottom):
 *   1. JLinkStatusHeader   — green/grey badge with target info + Connect/Disconnect
 *   2. JLinkResultCard     — most recent operation as a card (icon, title, payload)
 *   3. Two action cards    — Connection, Memory & Flash
 *   4. JLinkLogPanel       — collapsed by default; raw Commander log on demand
 *
 * The probe itself is one-shot per script — see JLinkStatus in the backend.
 */
export function JLinkFlashWorkspace() {
  const t = useT();
  const { config, setConfig, devices, busy, jlinkPath } = useJlinkBase();
  const status = useJlinkStore((s) => s.status);
  const clearStatus = useJlinkStore((s) => s.clearStatus);
  const refreshStatus = useJlinkStore((s) => s.refreshStatus);

  // Output log (raw Commander text). The result card above surfaces the
  // most-recent op at a glance; this is the long-tail record.
  const [output, setOutput] = useState("");

  // Transient toast (top-of-card banner). Times out automatically.
  const [toast, setToast] = useState<{ kind: "ok" | "fail" | "info"; msg: string } | null>(null);
  const toastTimer = useRef<number>(0);
  const showToast = (kind: "ok" | "fail" | "info", msg: string) => {
    setToast({ kind, msg });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  };

  // Visual representation of the most recent operation. Drives JLinkResultCard.
  const [lastResult, setLastResult] = useState<JLinkLastResult>({ state: "idle" });

  // Memory tool inputs
  const [readAddr, setReadAddr] = useState("0x20000000");
  const [readLen, setReadLen] = useState(64);
  const [writeAddr, setWriteAddr] = useState("0x20000000");
  const [writeData, setWriteData] = useState("");
  const [programAddr, setProgramAddr] = useState("");

  // Pick up the cached status on mount so the badge reflects the last session
  // even after a tab switch (the workspace stays mounted across switches).
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const append = (block: string) => setOutput((prev) => `${prev}${block}\n`);

  /**
   * Run one J-Link op, capture the result into the result card, append the
   * raw output to the log, and toast a short summary. Replaces the older
   * `useJlinkBase().runOp` for the Flash workspace so the UI can show
   * structured feedback instead of a log-only verdict.
   *
   * Callers can supply three extractors:
   *   - `summary(out, ok)`     — one-line headline (e.g. "0x20000000 · 16 字节")
   *   - `payload(out, ok)`     — short text shown in a `<pre>` block, copied to
   *                              the clipboard by the Copy button
   *   - `payloadNode(out, ok)` — a ReactNode that replaces the `<pre>` block
   *                              (used by read-mem to render the hex dump);
   *                              wins over `payload` when both are provided
   */
  const runOp = async (
    title: string,
    fn: () => Promise<{ success: boolean; output: string }>,
    extra?: {
      summary?: (out: string, ok: boolean) => string;
      payload?: (out: string, ok: boolean) => string | undefined;
      payloadNode?: (out: string, ok: boolean) => ReactNode | undefined;
    },
  ) => {
    if (busy) return;
    setLastResult({ state: "loading", title });
    const stamp = new Date().toLocaleTimeString();
    try {
      const res = await fn();
      append(`[${stamp}] ${title} — ${res.success ? "OK" : "FAILED"}\n${res.output.trim()}\n`);
      const ok = res.success;
      const summary = extra?.summary?.(res.output, ok);
      const payload = extra?.payload?.(res.output, ok);
      const payloadNode = extra?.payloadNode?.(res.output, ok);
      setLastResult({
        state: ok ? "ok" : "fail",
        title,
        summary,
        payload,
        payloadNode,
        detail: res.output.trim(),
      });
      showToast(ok ? "ok" : "fail", `${title} — ${ok ? "成功" : "失败"}`);
    } catch (err) {
      const detail = String(err);
      append(`[${stamp}] ${title} — FAILED\n${detail}\n`);
      setLastResult({ state: "fail", title, summary: detail, detail });
      showToast("fail", `${title} — 失败`);
    }
  };

  const onConnect = () => {
    if (busy) return;
    void runOp(
      t("jlink.connect"),
      () => jlink.connect(config, jlinkPath),
      {
        summary: (out, ok) => {
          if (!ok) return out.split("\n").find((l) => l.toUpperCase().includes("ERROR")) ?? t("jlink.notConnected");
          const sn = status.serial; // serial is set after this returns; we re-read from store below
          return sn ? `S/N ${sn}` : (config.iface + (config.speed > 0 ? ` @ ${config.speed} kHz` : " @ auto"));
        },
      },
    ).then(() => refreshStatus());
  };

  const onDisconnect = () => {
    jlink
      .disconnect()
      .then(() => {
        clearStatus();
        setLastResult({ state: "idle" });
        showToast("info", t("jlink.notConnected"));
      })
      .catch((e) => showToast("fail", String(e)));
  };

  const pickFile = async () => {
    const picked = await open({
      multiple: false,
      filters: [{ name: "Firmware", extensions: ["bin", "hex", "elf", "srec", "axf"] }],
    });
    return Array.isArray(picked) ? picked[0] : picked;
  };

  const isConnected = status.device.trim().length > 0;

  return (
    <div className="flex h-full flex-col bg-bg">
      <ModuleHeader icon={<Upload size={15} />} title={t("jlink.flash")} />
      <JLinkInstallBanner />

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-3">
          {/* Top status bar — replaces the "log only" feel */}
          <JLinkStatusHeader busy={busy} onConnect={onConnect} onDisconnect={onDisconnect} />

          {/* Transient toast (sits right under the status bar) */}
          {toast && (
            <div
              className={cn(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px]",
                toast.kind === "ok" && "border-success/30 bg-success/10 text-success",
                toast.kind === "fail" && "border-danger/30 bg-danger/10 text-danger",
                toast.kind === "info" && "border-border bg-surface text-fg",
              )}
            >
              {toast.msg}
            </div>
          )}

          {/* Last operation — the visual headline of the workspace */}
          <JLinkResultCard result={lastResult} />

          {/* Action cards */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <JLinkCard title={t("jlink.connection")} icon={<Power size={13} />}>
              <JLinkConnectionFields config={config} setConfig={setConfig} devices={devices} />
              <div className="flex flex-wrap gap-2 pt-1">
                {!isConnected ? (
                  <Button variant="primary" disabled={busy} onClick={onConnect}>
                    <Power size={14} /> {t("jlink.connect")}
                  </Button>
                ) : (
                  <Button variant="secondary" disabled={busy} onClick={onDisconnect}>
                    <Unplug size={14} /> {t("jlink.disconnect")}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  disabled={busy || !isConnected}
                  onClick={() => runOp(t("jlink.reset"), () => jlink.reset(config, "reset", jlinkPath))}
                >
                  <Zap size={14} /> {t("jlink.reset")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !isConnected}
                  onClick={() => runOp(t("jlink.halt"), () => jlink.reset(config, "halt", jlinkPath))}
                >
                  {t("jlink.halt")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !isConnected}
                  onClick={() => runOp(t("jlink.go"), () => jlink.reset(config, "go", jlinkPath))}
                >
                  {t("jlink.go")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || !isConnected}
                  onClick={() => runOp(t("jlink.erase"), () => jlink.erase(config, jlinkPath))}
                >
                  <Eraser size={14} /> {t("jlink.erase")}
                </Button>
              </div>
            </JLinkCard>

            <JLinkCard title={t("jlink.memoryFlash")} icon={<MemoryStick size={13} />}>
              <div className="grid grid-cols-[1fr_120px] gap-2">
                <Field label={t("jlink.readAddr")}>
                  <Input value={readAddr} onChange={(e) => setReadAddr(e.target.value)} placeholder="0x20000000" />
                </Field>
                <Field label={t("jlink.readLen")}>
                  <Input
                    type="number"
                    min={1}
                    value={readLen}
                    onChange={(e) => setReadLen(Number(e.target.value) || 0)}
                  />
                </Field>
              </div>
              <Button
                variant="secondary"
                disabled={busy || !isConnected}
                onClick={() => {
                  // Capture the user's input at click time so the parser can
                  // fall back to the address they typed when the banner is
                  // missing or in a different locale.
                  const typedAddr = readAddr.trim();
                  const fallbackAddr = Number.parseInt(typedAddr, 16);
                  const len = readLen;
                  void runOp(
                    t("jlink.readMem"),
                    () => jlink.readMem(config, typedAddr, len, jlinkPath),
                    {
                      summary: (_out, ok) => (ok ? `${typedAddr} · ${len} 字节` : "读取失败"),
                      // Render the bytes as a visual hex dump (address + 16
                      // bytes per row + ASCII gutter) instead of dumping the
                      // raw `<addr> = …` line into a `<pre>`.
                      payloadNode: (out, ok) => {
                        if (!ok) return undefined;
                        const parsed = parseMemOutput(out, Number.isFinite(fallbackAddr) ? fallbackAddr : 0);
                        if (!parsed) return undefined;
                        return <HexDump addr={parsed.addr} bytes={parsed.bytes} />;
                      },
                      // Clean hex string for the Copy button (one byte per
                      // 2-char group, space-separated, no address prefix).
                      payload: (out, ok) => {
                        if (!ok) return undefined;
                        const parsed = parseMemOutput(out, Number.isFinite(fallbackAddr) ? fallbackAddr : 0);
                        if (!parsed) return undefined;
                        return Array.from(parsed.bytes)
                          .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
                          .join(" ");
                      },
                    },
                  );
                }}
              >
                <MemoryStick size={14} /> {t("jlink.readMem")}
              </Button>

              <Field label={t("jlink.writeAddr")}>
                <Input value={writeAddr} onChange={(e) => setWriteAddr(e.target.value)} placeholder="0x20000000" />
              </Field>
              <Field label={t("jlink.writeData")}>
                <Input
                  value={writeData}
                  onChange={(e) => setWriteData(e.target.value)}
                  placeholder="0x12 0xAB 0x00"
                />
              </Field>
              <Button
                variant="secondary"
                disabled={busy || !isConnected || !writeData.trim()}
                onClick={() =>
                  runOp(
                    t("jlink.writeMem"),
                    () => jlink.writeMem(config, writeAddr, writeData, jlinkPath),
                    {
                      summary: (_out, ok) =>
                        ok ? `${writeAddr} · ${writeData.trim().split(/[\s,]+/).filter(Boolean).length} 字节` : "写入失败",
                    },
                  )
                }
              >
                <MemoryStick size={14} /> {t("jlink.writeMem")}
              </Button>

              <Field label={t("jlink.programAddr")}>
                <Input
                  value={programAddr}
                  onChange={(e) => setProgramAddr(e.target.value)}
                  placeholder="0x08000000"
                />
              </Field>
              <Button
                variant="secondary"
                disabled={busy || !isConnected}
                onClick={async () => {
                  const file = await pickFile();
                  if (!file) return;
                  await runOp(
                    t("jlink.programFirmware"),
                    () =>
                      jlink.program(
                        config,
                        file,
                        programAddr.trim() ? programAddr.trim() : undefined,
                        jlinkPath,
                      ),
                    {
                      summary: (out, ok) => {
                        if (!ok) return "烧录失败";
                        // Best-effort: look for "Downloading file..." or "Total time" lines.
                        const fileName = file.replace(/.*[\\/]/, "");
                        return `${fileName}${programAddr.trim() ? ` → ${programAddr.trim()}` : ""}`;
                      },
                    },
                  );
                }}
              >
                <Upload size={14} /> {t("jlink.programFirmware")}
              </Button>
            </JLinkCard>
          </div>

          {/* Collapsible log — collapsed by default so the result card is the headline */}
          <JLinkLogPanel
            title={t("jlink.outputConsole")}
            value={output}
            placeholder={t("jlink.noOutput")}
            defaultOpen={false}
          />
        </div>
      </div>
    </div>
  );
}
