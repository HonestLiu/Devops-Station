import { useMemo, useState } from "react";
import { Check, Copy, Download, FileCode2 } from "lucide-react";

import { useT } from "@/i18n";
import { Button, Dialog } from "@/components/ui";
import type { ProtocolConfig } from "@/lib/types";
import { generateCProtocol } from "./generateC";

/**
 * Modal that renders the C header generated from the current protocol draft and
 * lets the user copy it to the clipboard or download it as a `.h` file. Purely
 * a frontend convenience — `generateCProtocol` does the real work.
 */
export function ExportCDialog({
  open,
  onClose,
  config,
}: {
  open: boolean;
  onClose: () => void;
  config: ProtocolConfig;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const code = useMemo(() => (open ? generateCProtocol(config) : ""), [open, config]);
  const fileName = `${sanitizeFileName(config.name || "protocol")}.h`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked in some environments; ignore */
    }
  };

  const handleDownload = () => {
    const blob = new Blob([code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={t("protocol.exportCTitle")}
      description={t("protocol.exportCHint")}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.close")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t("protocol.copied") : t("protocol.copy")}
          </Button>
          <Button variant="primary" size="sm" onClick={handleDownload}>
            <Download size={13} />
            {t("protocol.download")}
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-bg px-3 py-2 text-[12px] text-muted">
        <FileCode2 size={14} className="shrink-0 text-accent" />
        <span className="truncate font-mono">{fileName}</span>
      </div>
      <pre className="mt-3 max-h-[48vh] overflow-auto rounded-lg border border-border bg-bg p-3 text-[12px] leading-relaxed text-fg">
        <code className="font-mono whitespace-pre">{code}</code>
      </pre>
    </Dialog>
  );
}

function sanitizeFileName(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^([0-9])/, "_$1");
  return cleaned || "protocol";
}
