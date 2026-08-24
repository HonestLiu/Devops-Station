import { useState } from "react";
import { Activity, Flame, MonitorDot, Settings2, Wrench } from "lucide-react";

import { Dialog } from "@/components/ui";
import { useAppStore } from "@/store/useAppStore";
import { useT, type TKey } from "@/i18n";
import { jlink } from "@/lib/api";

type ToolKey = "config" | "jflash" | "swo" | "rttviewer";

const TOOLS: {
  key: ToolKey;
  icon: React.ReactNode;
  name: TKey;
  desc: TKey;
}[] = [
  {
    key: "config",
    icon: <Settings2 size={16} />,
    name: "jlink.toolConfig",
    desc: "jlink.toolConfigDesc",
  },
  {
    key: "jflash",
    icon: <Flame size={16} />,
    name: "jlink.toolJFlash",
    desc: "jlink.toolJFlashDesc",
  },
  {
    key: "swo",
    icon: <Activity size={16} />,
    name: "jlink.toolSwo",
    desc: "jlink.toolSwoDesc",
  },
  {
    key: "rttviewer",
    icon: <MonitorDot size={16} />,
    name: "jlink.toolRttViewer",
    desc: "jlink.toolRttViewerDesc",
  },
];

/**
 * The 外部工具 popup — a dialog for launching SEGGER's own J-Link GUI tools
 * (J-Link Config, J-Flash, SWO / RTT Viewer) in their own windows. Opened from
 * the picker page instead of a dedicated workspace tab.
 */
export function JLinkToolsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const jlinkPath = useAppStore((s) => s.settings.jlinkPath);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);

  const launch = async (key: ToolKey) => {
    setStatus(null);
    try {
      const res = await jlink.launchTool(key, jlinkPath);
      setStatus({ text: res.output, ok: res.success });
    } catch (err) {
      setStatus({ text: String(err), ok: false });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("jlink.tools")}
      description={t("jlink.toolsHint")}
      width="max-w-md"
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {TOOLS.map((tool) => (
          <button
            key={tool.key}
            onClick={() => void launch(tool.key)}
            className="group flex items-center gap-3 rounded-lg border border-border bg-bg p-3 text-left transition-colors hover:border-accent/50 hover:bg-hover"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent transition-colors group-hover:bg-accent/25">
              {tool.icon}
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-fg">{t(tool.name)}</div>
              <div className="truncate text-[11px] text-subtle">{t(tool.desc)}</div>
            </div>
          </button>
        ))}
      </div>
      {status && (
        <p
          className={
            "mt-3 rounded-lg border p-2.5 font-mono text-[11px] " +
            (status.ok
              ? "border-success/30 bg-success/10 text-success"
              : "border-danger/30 bg-danger/10 text-danger")
          }
        >
          {status.text}
        </p>
      )}
    </Dialog>
  );
}
