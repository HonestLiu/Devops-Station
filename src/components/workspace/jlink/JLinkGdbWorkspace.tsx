import { useEffect, useRef, useState } from "react";
import { Play, Square } from "lucide-react";

import { Badge, Button, Field, Input } from "@/components/ui";
import { jlink } from "@/lib/api";
import { useT } from "@/i18n";
import { useJlinkBase } from "./useJlinkBase";
import { JLinkConnectionFields } from "./JLinkConnectionFields";
import { JLinkInstallWarning } from "./JLinkInstallWarning";

/**
 * GDB Server module — start/stop a J-Link GDB Server and watch its log. Split
 * out of the old monolithic J-Link page into its own module tab. The server is
 * a long-lived backend child, so it keeps running across tab switches; this
 * workspace re-attaches to the event stream on mount.
 */
export function JLinkGdbWorkspace() {
  const t = useT();
  const { config, setConfig, devices, busy, jlinkPath } = useJlinkBase();
  const [gdbPort, setGdbPort] = useState(2331);
  const [gdbRunning, setGdbRunning] = useState(false);
  const [gdbLog, setGdbLog] = useState("");
  const [starting, setStarting] = useState(false);

  const gdbRef = useRef<HTMLPreElement>(null);

  // Liveness + re-attach to the streaming log on mount (survives tab switches).
  useEffect(() => {
    let alive = true;
    jlink
      .gdbRunning()
      .then((v) => alive && setGdbRunning(v))
      .catch(() => {});
    let un: (() => void) | undefined;
    jlink
      .onGdbLog((line) => setGdbLog((prev) => `${prev}${line}\n`))
      .then((fn) => (un = fn))
      .catch(() => {});
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  useEffect(() => {
    gdbRef.current?.scrollTo({ top: gdbRef.current.scrollHeight });
  }, [gdbLog]);

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* ---- Connection config ---- */}
          <section className="rounded-xl border border-border bg-surface p-4">
            <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-subtle">
              {t("jlink.connection")}
            </h2>
            <div className="flex flex-col gap-3">
              <JLinkConnectionFields
                config={config}
                setConfig={setConfig}
                devices={devices}
              />
            </div>
          </section>

          {/* ---- GDB Server ---- */}
          <section className="rounded-xl border border-border bg-surface p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">
                {t("jlink.gdbServer")}
              </h2>
              {gdbRunning ? (
                <Badge tone="success">{t("jlink.running")}</Badge>
              ) : (
                <Badge tone="neutral">{t("jlink.notRunning")}</Badge>
              )}
            </div>

            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field label={t("jlink.port")}>
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
                  <Square size={14} /> {t("jlink.stop")}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  disabled={busy || starting}
                  onClick={async () => {
                    setStarting(true);
                    try {
                      const res = await jlink.gdbStart(config, gdbPort, jlinkPath);
                      setGdbLog((p) => `${p}${res.output}\n`);
                      setGdbRunning(res.success);
                    } catch (err) {
                      setGdbLog((p) => `${p}${String(err)}\n`);
                    } finally {
                      setStarting(false);
                    }
                  }}
                >
                  <Play size={14} /> {t("jlink.start")}
                </Button>
              )}
            </div>

            <pre
              ref={gdbRef}
              className="mt-3 h-64 overflow-auto rounded-lg border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed text-muted"
            >
              {gdbLog || t("jlink.gdbLogPh")}
            </pre>
          </section>
        </div>

        <JLinkInstallWarning />
      </div>
    </div>
  );
}
