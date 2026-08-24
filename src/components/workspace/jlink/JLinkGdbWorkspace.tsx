import { useEffect, useState } from "react";
import { Play, Server, Square } from "lucide-react";

import { Badge, Button, Field, Input, ModuleHeader } from "@/components/ui";
import { jlink } from "@/lib/api";
import { useT } from "@/i18n";
import { useJlinkBase } from "./useJlinkBase";
import { JLinkConnectionFields } from "./JLinkConnectionFields";
import { JLinkInstallBanner, JLinkCard, JLinkConsole } from "./JLinkShared";

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

  const runningBadge = gdbRunning ? (
    <Badge tone="success">{t("jlink.running")}</Badge>
  ) : (
    <Badge tone="neutral">{t("jlink.notRunning")}</Badge>
  );

  return (
    <div className="flex h-full flex-col bg-bg">
      <ModuleHeader
        icon={<Server size={15} />}
        title={t("jlink.gdb")}
        badges={runningBadge}
      />
      <JLinkInstallBanner />

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* ---- Connection config ---- */}
            <JLinkCard title={t("jlink.connection")} icon={<Server size={13} />}>
              <JLinkConnectionFields
                config={config}
                setConfig={setConfig}
                devices={devices}
              />
            </JLinkCard>

            {/* ---- GDB Server ---- */}
            <JLinkCard title={t("jlink.gdbServer")} icon={<Server size={13} />} right={runningBadge}>
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
            </JLinkCard>
          </div>

          {/* ---- GDB log console (full width) ---- */}
          <JLinkConsole
            title={t("jlink.gdbServer")}
            value={gdbLog}
            placeholder={t("jlink.gdbLogPh")}
          />
        </div>
      </div>
    </div>
  );
}
