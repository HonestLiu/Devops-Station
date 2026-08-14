import { useEffect, useState } from "react";
import { ChevronRight, ExternalLink, Github } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";

import { Badge, Button, Dialog } from "@/components/ui";
import { cn } from "@/lib/utils";
import { CheckForUpdatesButton } from "./UpdateDialog";

/**
 * Software introduction shown at the top of the About dialog.
 */
const INTRO = [
  "DevOps Station 是一个融合 Termius、SecureCRT、MobaXterm、VS Code Terminal、Serial Studio、yazi 等工具能力的现代运维终端工作站。",
  "内置本地 Shell（自动适配 PowerShell / pwsh / bash / zsh / fish）、SSH、SFTP 文件传输、串口与蓝牙串口、WSL 以及 FRP 内网穿透，并提供 AI 助手、命令片段、实时监控等功能，覆盖日常运维与嵌入式调试场景。",
];

/** Open-source references surfaced inside the collapsible declaration. */
const REFERENCES: { name: string; url: string; note: string }[] = [
  {
    name: "BaudDance/SerialAssistant",
    url: "https://github.com/BaudDance/SerialAssistant",
    note: "串口（Serial）功能的参考与派生来源。",
  },
];

export function AboutDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [showOss, setShowOss] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    let alive = true;
    getVersion()
      .then((v) => {
        if (alive) setVersion(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  };

  const openUrl = (url: string) => {
    // New-tab navigation routes through the OS default browser in Tauri.
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <Dialog open={open} onClose={onClose} title="About DevOps Station">
      {/* Brand header */}
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent font-mono text-[16px] font-bold text-accent-fg shadow-sm">
          {">_"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold text-fg">DevOps Station</span>
            <Badge tone="accent">{version ? `v${version}` : "…"}</Badge>
          </div>
          <p className="text-[12px] text-subtle">All-in-one DevOps terminal workstation</p>
        </div>
        <CheckForUpdatesButton />
      </div>

      {/* Introduction */}
      <div className="flex flex-col gap-2.5 text-[13px] leading-relaxed text-muted">
        {INTRO.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      {/* Open-source declaration — hidden by default, click to view */}
      <div className="mt-4 rounded-lg border border-border bg-bg">
        <button
          type="button"
          onClick={() => setShowOss((v) => !v)}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[13px] font-medium text-fg transition-colors hover:bg-hover"
        >
          <ChevronRight
            size={15}
            className={cn(
              "shrink-0 text-subtle transition-transform",
              showOss && "rotate-90",
            )}
          />
          Open Source Declaration（点击查看）
        </button>

        {showOss && (
          <div className="border-t border-border px-3 py-3 text-[12px] leading-relaxed text-muted">
            <p className="mb-2">
              本项目尊重并复用优秀的开源成果，遵循相关开源协议。主要开源参考如下：
            </p>

            <ul className="flex flex-col gap-2">
              {REFERENCES.map((r) => (
                <li
                  key={r.url}
                  className="rounded-lg border border-border bg-elevated px-3 py-2.5"
                >
                  <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
                    <Github size={14} className="shrink-0 text-subtle" />
                    {r.name}
                  </div>
                  <p className="mt-1 text-[11px] text-subtle">{r.note}</p>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openUrl(r.url)}
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"
                    >
                      <ExternalLink size={12} />
                      {r.url}
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      onClick={() => copy(r.url)}
                    >
                      {copied === r.url ? "Copied" : "Copy"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>

            <p className="mt-3 text-[11px] text-subtle">
              若您是其中项目的作者或维护者，欢迎通过本项目渠道联系我们以完善署名与协议合规。
            </p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
