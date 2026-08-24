import { useMemo, useState } from "react";
import { Check, Copy, Download, FileArchive, FileCode2, Loader2 } from "lucide-react";

import { useT } from "@/i18n";
import { Button, Dialog } from "@/components/ui";
import { CodeHighlight, type CodeLang } from "@/components/CodeHighlight";
import type { ProtocolConfig } from "@/lib/types";
import { generateCProtocol } from "./generateC";
import { buildZip } from "@/lib/zip";

type TabId = "h" | "c" | "main" | "readme" | "project";

/**
 * Modal that renders the C header + source generated from the current protocol
 * draft. Three preview tabs (`.h`, `.c`, `main.c`) plus a "project" tab that
 * exports a complete, buildable CMake project as a single `.zip` archive.
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
  const [tab, setTab] = useState<TabId>("h");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exported, setExported] = useState(false);

  const files = useMemo(() => (open ? generateCProtocol(config) : null), [open, config]);
  const base = files?.base ?? "protocol";

  const code =
    tab === "h"
      ? files?.header
      : tab === "c"
        ? files?.source
        : tab === "main"
          ? files?.main
          : tab === "readme"
            ? files?.readme
            : files?.cmake;

  const codeLang: CodeLang =
    tab === "h" || tab === "c" || tab === "main" ? "c"
      : tab === "readme" ? "markdown" : "cmake";
  const tabLabel =
    tab === "h"
      ? `${base}.h`
      : tab === "c"
        ? `${base}.c`
        : tab === "main"
          ? "main.c"
          : tab === "readme"
            ? "README.md"
            : "CMakeLists.txt";

  const resetTransient = () => {
    setCopied(false);
    setExported(false);
  };

  const handleCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      resetTransient();
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked in some environments; ignore */
    }
  };

  const downloadBlob = (filename: string, blob: Blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownloadSingle = () => {
    if (!code) return;
    downloadBlob(tabLabel, new Blob([code], { type: "text/plain;charset=utf-8" }));
  };

  // Build the full project as a single ZIP and let the user pick where to save
  // it. The Tauri `save` dialog pre-selects the export directory + filename, so
  // this is a single save prompt (no multi-file WebView warning).
  const handleExportProject = async () => {
    if (!files || busy) return;
    setBusy(true);
    resetTransient();
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const target = await save({
        title: t("protocol.exportProject"),
        defaultPath: `${base}_project.zip`,
        filters: [{ name: "ZIP archive", extensions: ["zip"] }],
      });
      if (!target) {
        setBusy(false);
        return;
      }
      const zip = buildZip([
        { name: `${base}.h`, content: files.header },
        { name: `${base}.c`, content: files.source },
        { name: "main.c", content: files.main },
        { name: "CMakeLists.txt", content: files.cmake },
        { name: "README.md", content: files.readme },
      ]);
      downloadBlob(target.split(/[\\/]/).pop() ?? `${base}_project.zip`, zip);
      setExported(true);
      window.setTimeout(() => setExported(false), 2500);
    } catch {
      // Outside the desktop app (web preview) fall back to a direct download.
      if (files) {
        const zip = buildZip([
          { name: `${base}.h`, content: files.header },
          { name: `${base}.c`, content: files.source },
          { name: "main.c", content: files.main },
          { name: "CMakeLists.txt", content: files.cmake },
          { name: "README.md", content: files.readme },
        ]);
        downloadBlob(`${base}_project.zip`, zip);
      }
    } finally {
      setBusy(false);
    }
  };

  const tabBtn = (id: TabId, label: string) => (
    <button
      type="button"
      onClick={() => {
        setTab(id);
        resetTransient();
      }}
      className={
        "rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors " +
        (tab === id ? "bg-accent text-accent-fg" : "bg-hover text-muted hover:text-fg")
      }
    >
      {label}
    </button>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width="max-w-2xl"
      title={t("protocol.exportCTitle")}
      description={t("protocol.exportCHint")}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            {t("common.close")}
          </Button>
          {tab === "project" ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleExportProject()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : exported ? (
                <Check size={13} />
              ) : (
                <FileArchive size={13} />
              )}
              {busy
                ? t("protocol.exporting")
                : exported
                  ? t("protocol.exported")
                  : t("protocol.exportProject")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" size="sm" onClick={() => void handleCopy()} disabled={busy}>
                {copied ? <Check size={13} /> : <Copy size={13} />}
                {copied ? t("protocol.copied") : t("protocol.copy")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleDownloadSingle}
                disabled={busy}
              >
                <Download size={13} />
                {t("protocol.download")}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {tabBtn("h", `${base}.h`)}
        {tabBtn("c", `${base}.c`)}
        {tabBtn("main", "main.c")}
        {tabBtn("readme", t("protocol.readme"))}
        {tabBtn("project", t("protocol.projectFiles"))}
      </div>
      {tab === "project" && (
        <p className="mt-2 text-[11px] leading-relaxed text-subtle">
          {t("protocol.exportProjectHint")}
        </p>
      )}
      {exported && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-success">
          <Check size={12} /> {t("protocol.exportDone")}
        </p>
      )}
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-bg px-3 py-2 text-[12px] text-muted">
        <FileCode2 size={14} className="shrink-0 text-accent" />
        <span className="truncate font-mono">{tabLabel}</span>
      </div>
      <CodeHighlight
        code={code ?? ""}
        lang={codeLang}
        className="mt-3 max-h-[48vh]"
      />
    </Dialog>
  );
}
