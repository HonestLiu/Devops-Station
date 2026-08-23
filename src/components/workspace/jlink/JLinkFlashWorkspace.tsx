import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Download, Eraser, MemoryStick, Power, Zap } from "lucide-react";

import { Button, Field, Input } from "@/components/ui";
import { jlink } from "@/lib/api";
import { useT } from "@/i18n";
import { useJlinkBase } from "./useJlinkBase";
import { JLinkConnectionFields } from "./JLinkConnectionFields";
import { JLinkInstallWarning } from "./JLinkInstallWarning";

/**
 * Flash 下载 module — the probe connection controls plus memory read/write and
 * firmware programming, with a shared operation console. Split out of the old
 * monolithic J-Link page into its own module tab.
 */
export function JLinkFlashWorkspace() {
  const t = useT();
  const { config, setConfig, devices, busy, jlinkPath, runOp } = useJlinkBase();
  const [output, setOutput] = useState("");

  // Memory tools
  const [readAddr, setReadAddr] = useState("0x20000000");
  const [readLen, setReadLen] = useState(64);
  const [writeAddr, setWriteAddr] = useState("0x20000000");
  const [writeData, setWriteData] = useState("");
  const [programAddr, setProgramAddr] = useState("");

  const outRef = useRef<HTMLPreElement>(null);

  const append = (block: string) => setOutput((prev) => `${prev}${block}\n`);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [output]);

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
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ---- Connection config ---- */}
          <section className={card}>
            <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-subtle">
              {t("jlink.connection")}
            </h2>

            <div className="flex flex-col gap-3">
              <JLinkConnectionFields
                config={config}
                setConfig={setConfig}
                devices={devices}
              />
              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() =>
                    runOp("Connect", () => jlink.connect(config, jlinkPath), append)
                  }
                >
                  <Power size={14} /> {t("jlink.connectTest")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    runOp("Reset", () => jlink.reset(config, "reset", jlinkPath), append)
                  }
                >
                  <Zap size={14} /> {t("jlink.reset")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    runOp("Halt", () => jlink.reset(config, "halt", jlinkPath), append)
                  }
                >
                  {t("jlink.halt")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    runOp("Go", () => jlink.reset(config, "go", jlinkPath), append)
                  }
                >
                  {t("jlink.go")}
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => runOp("Erase", () => jlink.erase(config, jlinkPath), append)}
                >
                  <Eraser size={14} /> {t("jlink.erase")}
                </Button>
              </div>
            </div>
          </section>

          {/* ---- Memory & Flash ---- */}
          <section className={card}>
            <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-subtle">
              {t("jlink.memoryFlash")}
            </h2>

            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-[1fr_120px] gap-2">
                <Field label={t("jlink.readAddr")}>
                  <Input
                    value={readAddr}
                    onChange={(e) => setReadAddr(e.target.value)}
                    placeholder="0x20000000"
                  />
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
                disabled={busy}
                onClick={() =>
                  runOp(
                    "Read Memory",
                    () => jlink.readMem(config, readAddr, readLen, jlinkPath),
                    append,
                  )
                }
              >
                <MemoryStick size={14} /> {t("jlink.readMem")}
              </Button>

              <Field label={t("jlink.writeAddr")}>
                <Input
                  value={writeAddr}
                  onChange={(e) => setWriteAddr(e.target.value)}
                  placeholder="0x20000000"
                />
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
                disabled={busy || !writeData.trim()}
                onClick={() =>
                  runOp(
                    "Write Memory",
                    () => jlink.writeMem(config, writeAddr, writeData, jlinkPath),
                    append,
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
                disabled={busy}
                onClick={async () => {
                  const file = await pickFile();
                  if (!file) return;
                  await runOp(
                    "Program Flash",
                    () =>
                      jlink.program(
                        config,
                        file,
                        programAddr.trim() ? programAddr.trim() : undefined,
                        jlinkPath,
                      ),
                    append,
                  );
                }}
              >
                <Download size={14} /> {t("jlink.programFirmware")}
              </Button>
            </div>
          </section>

          {/* ---- Output console ---- */}
          <section className={card}>
            <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">
              {t("jlink.outputConsole")}
            </h2>
            <pre
              ref={outRef}
              className="h-64 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted"
            >
              {output || t("jlink.noOutput")}
            </pre>
          </section>
        </div>

        <JLinkInstallWarning />
      </div>
    </div>
  );
}
