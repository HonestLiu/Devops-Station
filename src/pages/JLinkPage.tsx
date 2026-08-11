import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Cpu,
  Download,
  Eraser,
  MemoryStick,
  Play,
  Power,
  Square,
  Zap,
} from "lucide-react";

import { Badge, Button, Field, Input, Select } from "@/components/ui";
import { jlink } from "@/lib/api";
import type { JLinkConfig } from "@/lib/types";
import { useAppStore } from "@/store/useAppStore";

/** Fallback device list shown before the driver's device database loads. */
const DEVICE_PRESETS = [
  "STM32F103C8",
  "STM32F407VG",
  "STM32L4",
  "STM32H7",
  "nRF52840_xxAA",
  "nRF5340_xxAA",
  "GD32F303",
  "ATSAMD21G18",
  "RP2040",
  "MIMXRT1052",
  "LPC1768",
];

const SPEEDS = [0, 100, 400, 1000, 2000, 4000, 8000];

const inputCls =
  "h-9 w-full rounded-lg border border-border bg-bg px-2.5 text-[13px] text-fg outline-none focus:border-accent";

/** Append a labelled block to the output console. */
function appendBlock(prev: string, title: string, body: string, ok: boolean): string {
  const stamp = new Date().toLocaleTimeString();
  const head = `[${stamp}] ${title} — ${ok ? "OK" : "FAILED"}`;
  return `${prev}\n${head}\n${body.trim()}\n`.trimStart();
}

export function JLinkPage() {
  const jlinkPath = useAppStore((s) => s.settings.jlinkPath);
  const [config, setConfig] = useState<JLinkConfig>({
    device: "STM32F103C8",
    iface: "SWD",
    speed: 4000,
  });
  const [available, setAvailable] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<string[]>(DEVICE_PRESETS);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");

  // Memory tools
  const [readAddr, setReadAddr] = useState("0x20000000");
  const [readLen, setReadLen] = useState(64);
  const [writeAddr, setWriteAddr] = useState("0x20000000");
  const [writeData, setWriteData] = useState("");
  const [programAddr, setProgramAddr] = useState("");

  // GDB server
  const [gdbPort, setGdbPort] = useState(2331);
  const [gdbRunning, setGdbRunning] = useState(false);
  const [gdbLog, setGdbLog] = useState("");

  const outRef = useRef<HTMLPreElement>(null);
  const gdbRef = useRef<HTMLPreElement>(null);

  // Availability + driver device list + GDB liveness. Reloads when the
  // configured J-Link path changes (e.g. after editing Settings).
  useEffect(() => {
    let alive = true;
    jlink
      .available(jlinkPath)
      .then((v) => alive && setAvailable(v))
      .catch(() => alive && setAvailable(false));
    jlink
      .devices(jlinkPath)
      .then((list) => {
        if (alive && list.length) setDevices(list);
      })
      .catch(() => {});
    jlink
      .gdbRunning()
      .then((v) => alive && setGdbRunning(v))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [jlinkPath]);

  // Stream GDB server logs.
  useEffect(() => {
    let un: (() => void) | undefined;
    jlink
      .onGdbLog((line) => setGdbLog((prev) => `${prev}${line}\n`))
      .then((fn) => (un = fn))
      .catch(() => {});
    return () => un?.();
  }, []);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [output]);
  useEffect(() => {
    gdbRef.current?.scrollTo({ top: gdbRef.current.scrollHeight });
  }, [gdbLog]);

  /** Run a J-Link operation, capturing its result into the output console. */
  async function runOp(title: string, fn: () => Promise<{ success: boolean; output: string }>) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      setOutput((prev) => appendBlock(prev, title, res.output || "(no output)", res.success));
    } catch (err) {
      setOutput((prev) => appendBlock(prev, title, String(err), false));
    } finally {
      setBusy(false);
    }
  }

  const pickFile = async () => {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Firmware", extensions: ["bin", "hex", "elf", "srec", "axf"] },
      ],
    });
    return Array.isArray(picked) ? picked[0] : picked;
  };

  const card = "rounded-xl border border-border bg-surface p-4";

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Cpu size={18} />
          </div>
          <div className="flex-1">
            <h1 className="text-[15px] font-semibold text-fg">J-Link</h1>
            <p className="text-[12px] text-subtle">
              图形化调用 SEGGER J-Link 的常用功能（连接、复位、内存读写、烧录、GDB Server）
            </p>
          </div>
          {available === null ? (
            <Badge tone="neutral">检测中…</Badge>
          ) : available ? (
            <Badge tone="success">J-Link 已安装</Badge>
          ) : (
            <Badge tone="warning">未检测到 J-Link 软件</Badge>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ---- Connection config ---- */}
          <section className={card}>
            <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-subtle">
              连接配置
            </h2>

            <div className="flex flex-col gap-3">
              <Field label="目标设备 (Device)">
                <input
                  list="jlink-devices"
                  className={inputCls}
                  value={config.device}
                  onChange={(e) =>
                    setConfig((c) => ({ ...c, device: e.target.value }))
                  }
                  placeholder="选择或输入设备，如 STM32F103C8"
                />
                <datalist id="jlink-devices">
                  {devices.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
                <p className="mt-1.5 text-[11px] text-subtle">
                  {devices.length} 个设备（来自 J-Link 驱动，可输入过滤，也支持自定义型号）
                </p>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="接口 (Interface)">
                  <Select
                    value={config.iface}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, iface: e.target.value as JLinkConfig["iface"] }))
                    }
                  >
                    <option value="SWD">SWD</option>
                    <option value="JTAG">JTAG</option>
                  </Select>
                </Field>
                <Field label="速度 (kHz, 0=自动)">
                  <Select
                    value={String(config.speed)}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, speed: Number(e.target.value) }))
                    }
                  >
                    {SPEEDS.map((s) => (
                      <option key={s} value={s}>
                        {s === 0 ? "Auto" : `${s} kHz`}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    runOp("Connect", () => jlink.connect(config, jlinkPath))
                  }
                >
                  <Power size={14} /> 连接测试
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => runOp("Reset", () => jlink.reset(config, "reset", jlinkPath))}
                >
                  <Zap size={14} /> 复位
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => runOp("Halt", () => jlink.reset(config, "halt", jlinkPath))}
                >
                  暂停 (Halt)
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => runOp("Go", () => jlink.reset(config, "go", jlinkPath))}
                >
                  运行 (Go)
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => runOp("Erase", () => jlink.erase(config, jlinkPath))}
                >
                  <Eraser size={14} /> 全片擦除
                </Button>
              </div>
            </div>
          </section>

          {/* ---- Memory & Flash ---- */}
          <section className={card}>
            <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-subtle">
              内存与烧录
            </h2>

            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-[1fr_120px] gap-2">
                <Field label="读取地址">
                  <Input
                    value={readAddr}
                    onChange={(e) => setReadAddr(e.target.value)}
                    placeholder="0x20000000"
                  />
                </Field>
                <Field label="长度 (字节)">
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
                disabled={busy}
                onClick={() =>
                  runOp("Read Memory", () =>
                    jlink.readMem(config, readAddr, readLen, jlinkPath),
                  )
                }
              >
                <MemoryStick size={14} /> 读取内存
              </Button>

              <Field label="写入地址">
                <Input
                  value={writeAddr}
                  onChange={(e) => setWriteAddr(e.target.value)}
                  placeholder="0x20000000"
                />
              </Field>
              <Field label="写入数据 (十六进制字节，空格分隔，如 0x12 0xAB 0x00)">
                <Input
                  value={writeData}
                  onChange={(e) => setWriteData(e.target.value)}
                  placeholder="0x12 0xAB 0x00"
                />
              </Field>
              <Button
                variant="secondary"
                disabled={busy || !writeData.trim()}
                onClick={() =>
                  runOp("Write Memory", () =>
                    jlink.writeMem(config, writeAddr, writeData, jlinkPath),
                  )
                }
              >
                <MemoryStick size={14} /> 写入内存
              </Button>

              <Field label="烧录地址 (可选，留空使用文件默认/0)">
                <Input
                  value={programAddr}
                  onChange={(e) => setProgramAddr(e.target.value)}
                  placeholder="0x08000000"
                />
              </Field>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  const file = await pickFile();
                  if (!file) return;
                  await runOp("Program Flash", () =>
                    jlink.program(
                      config,
                      file,
                      programAddr.trim() ? programAddr.trim() : undefined,
                      jlinkPath,
                    ),
                  );
                }}
              >
                <Download size={14} /> 烧录固件 (Program)
              </Button>
            </div>
          </section>

          {/* ---- Output console ---- */}
          <section className={card}>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">
              操作输出
            </h2>
            <pre
              ref={outRef}
              className="h-64 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted"
            >
              {output || "（操作结果将显示在这里）"}
            </pre>
          </section>

          {/* ---- GDB Server ---- */}
          <section className={card}>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">
                GDB Server
              </h2>
              {gdbRunning ? (
                <Badge tone="success">运行中</Badge>
              ) : (
                <Badge tone="neutral">未运行</Badge>
              )}
            </div>

            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field label="端口">
                  <Input
                    type="number"
                    value={gdbPort}
                    onChange={(e) => setGdbPort(Number(e.target.value) || 2331)}
                  />
                </Field>
              </div>
              {gdbRunning ? (
                <Button
                  variant="danger"
                  onClick={async () => {
                    const res = await jlink.gdbStop();
                    setGdbLog((p) => `${p}${res.output}\n`);
                    setGdbRunning(false);
                  }}
                >
                  <Square size={14} /> 停止
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const res = await jlink.gdbStart(config, gdbPort, jlinkPath);
                      setGdbLog((p) => `${p}${res.output}\n`);
                      setGdbRunning(res.success);
                    } catch (err) {
                      setGdbLog((p) => `${p}${String(err)}\n`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Play size={14} /> 启动
                </Button>
              )}
            </div>

            <pre
              ref={gdbRef}
              className="mt-3 h-40 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted"
            >
              {gdbLog || "（GDB Server 日志将实时显示在这里）"}
            </pre>
          </section>
        </div>

        {available === false && (
          <p className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-[12px] text-warning">
            未检测到 SEGGER J-Link 软件。请安装{" "}
            <span className="font-mono">J-Link Software and Documentation Pack</span>{" "}
            并确保其位于系统 PATH 或默认安装目录（如{" "}
            <span className="font-mono">C:\Program Files (x86)\SEGGER\JLink</span>
            ），或在 设置 → J-Link 中指定可执行文件路径。
          </p>
        )}
      </div>
    </div>
  );
}
