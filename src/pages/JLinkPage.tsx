import { useEffect } from "react";
import { Cpu, Download, Radio, Server } from "lucide-react";

import { Badge } from "@/components/ui";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { useJlinkStore } from "@/store/useJlinkStore";
import { useTabsStore } from "@/store/useTabsStore";
import type { JLinkModule } from "@/lib/types";

/**
 * J-Link module picker — the `/jlink` landing page. Mirrors the MQTT picker:
 * a set of big cards, each opening its module as a singleton tab
 * (`openJlinkModule`). The SEGGER availability badge lives here too.
 */
export function JLinkPage() {
  const t = useT();
  const jlinkPath = useAppStore((s) => s.settings.jlinkPath);
  const available = useJlinkStore((s) => s.available);
  const load = useJlinkStore((s) => s.load);
  const openJlinkModule = useTabsStore((s) => s.openJlinkModule);

  useEffect(() => {
    load(jlinkPath);
  }, [jlinkPath, load]);

  const modules: {
    key: JLinkModule;
    icon: React.ReactNode;
    title: string;
    desc: string;
    beta?: boolean;
  }[] = [
    {
      key: "flash",
      icon: <Download size={22} />,
      title: t("jlink.flash"),
      desc: t("jlink.moduleFlashDesc"),
    },
    {
      key: "rtt",
      icon: <Radio size={22} />,
      title: t("jlink.rtt"),
      desc: t("jlink.moduleRttDesc"),
      beta: true,
    },
    {
      key: "gdb",
      icon: <Server size={22} />,
      title: t("jlink.gdb"),
      desc: t("jlink.moduleGdbDesc"),
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-3xl px-6 py-10">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/15 text-accent">
            <Cpu size={18} />
          </div>
          <div className="flex-1">
            <h1 className="text-[15px] font-semibold text-fg">{t("jlink.title")}</h1>
            <p className="text-[12px] text-subtle">{t("jlink.subtitle")}</p>
          </div>
          {available === null ? (
            <Badge tone="neutral">{t("jlink.detecting")}</Badge>
          ) : available ? (
            <Badge tone="success">{t("jlink.installed")}</Badge>
          ) : (
            <Badge tone="warning">{t("jlink.notFound")}</Badge>
          )}
        </div>

        <h1 className="mt-8 text-[18px] font-semibold text-fg">{t("jlink.chooseModule")}</h1>
        <p className="mt-1 text-[13px] text-muted">{t("jlink.chooseModuleDesc")}</p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {modules.map((m) => (
            <button
              key={m.key}
              onClick={() => openJlinkModule(m.key)}
              className="group relative flex flex-col rounded-xl border border-border/60 bg-bg p-5 text-left transition-all hover:border-accent/50 hover:shadow-md hover:shadow-accent/5"
            >
              {m.beta && (
                <span className="absolute right-3 top-3 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500 ring-1 ring-inset ring-amber-500/30">
                  Beta
                </span>
              )}
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent/15 text-accent transition-colors group-hover:bg-accent/25">
                {m.icon}
              </div>
              <div className="mt-3 text-[15px] font-semibold text-fg">{m.title}</div>
              <div className="mt-1 text-[12px] leading-relaxed text-muted">{m.desc}</div>
            </button>
          ))}
        </div>

        {available === false && (
          <p className="mt-6 rounded-lg border border-warning/30 bg-warning/10 p-3 text-[12px] text-warning">
            {t("jlink.installWarning", {
              pack: "J-Link Software and Documentation Pack",
              dir: "C:\\Program Files (x86)\\SEGGER\\JLink",
            })}
          </p>
        )}
      </div>
    </div>
  );
}
