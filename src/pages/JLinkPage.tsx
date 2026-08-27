import { useEffect, useState } from "react";
import { Cpu, Radio, Server, Upload, Wrench } from "lucide-react";

import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { useJlinkStore } from "@/store/useJlinkStore";
import { useTabsStore } from "@/store/useTabsStore";
import type { JLinkModule } from "@/lib/types";
import { ModuleHeader } from "@/components/ui";
import { JLinkInstallBanner } from "@/components/workspace/jlink/JLinkShared";
import { JLinkToolsDialog } from "@/components/workspace/jlink/JLinkToolsDialog";

/**
 * J-Link module picker — the `/jlink` landing page. Mirrors the MQTT picker:
 * a set of big cards, each opening its module as a singleton tab
 * (`openJlinkModule`) except 外部工具, which pops a launcher dialog instead. A
 * not-installed banner shares chrome with the module workspaces so the whole
 * J-Link area reads as one family.
 */
export function JLinkPage() {
  const t = useT();
  const jlinkPath = useAppStore((s) => s.settings.jlinkPath);
  const load = useJlinkStore((s) => s.load);
  const openJlinkModule = useTabsStore((s) => s.openJlinkModule);
  const [toolsOpen, setToolsOpen] = useState(false);

  useEffect(() => {
    load(jlinkPath);
  }, [jlinkPath, load]);

  const modules: {
    key: JLinkModule | "tools";
    icon: React.ReactNode;
    title: string;
    desc: string;
    beta?: boolean;
  }[] = [
    {
      key: "flash",
      icon: <Upload size={22} />,
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
    {
      key: "tools",
      icon: <Wrench size={22} />,
      title: t("jlink.tools"),
      desc: t("jlink.moduleToolsDesc"),
    },
  ];

  return (
    <div className="flex h-full flex-col bg-bg">
      <ModuleHeader icon={<Cpu size={15} />} title={t("jlink.title")} />
      <JLinkInstallBanner />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-[16px] font-semibold text-fg">{t("jlink.chooseModule")}</h1>
          <p className="mt-1 text-[12px] text-muted">{t("jlink.chooseModuleDesc")}</p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {modules.map((m) => (
              <button
                key={m.key}
                onClick={() => (m.key === "tools" ? setToolsOpen(true) : openJlinkModule(m.key))}
                className="group relative flex flex-col rounded-xl border border-border bg-surface p-5 text-left transition-all hover:border-accent/50 hover:shadow-md hover:shadow-accent/5"
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
        </div>
      </div>

      <JLinkToolsDialog open={toolsOpen} onClose={() => setToolsOpen(false)} />
    </div>
  );
}
