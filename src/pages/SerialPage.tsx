import { Cable, FileCog } from "lucide-react";

import { useT } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import { ModuleHeader } from "@/components/ui";

/**
 * Serial module picker — the `/serial` landing page, mirroring the J-Link
 * picker. Two big cards: 基础串口工具 (opens the serial / BLE launcher as a
 * singleton tab) and 协议设计器 (opens the protocol-designer placeholder, still
 * Beta). Each module opens as a singleton tab via `openSerialModule`; a module
 * already open is focused rather than duplicated.
 */
export function SerialPage() {
  const t = useT();
  const openSerialModule = useTabsStore((s) => s.openSerialModule);

  const modules: {
    key: "basic" | "designer";
    icon: React.ReactNode;
    title: string;
    desc: string;
    beta?: boolean;
  }[] = [
    {
      key: "basic",
      icon: <Cable size={22} />,
      title: t("serial.moduleBasic"),
      desc: t("serial.moduleBasicDesc"),
    },
    {
      key: "designer",
      icon: <FileCog size={22} />,
      title: t("serial.moduleDesigner"),
      desc: t("serial.moduleDesignerDesc"),
      beta: true,
    },
  ];

  return (
    <div className="flex h-full flex-col bg-bg">
      <ModuleHeader icon={<Cable size={15} />} title={t("nav.serial")} />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-[16px] font-semibold text-fg">{t("serial.chooseModule")}</h1>
          <p className="mt-1 text-[12px] text-muted">{t("serial.chooseModuleDesc")}</p>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            {modules.map((m) => (
              <button
                key={m.key}
                onClick={() => openSerialModule(m.key)}
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
    </div>
  );
}
