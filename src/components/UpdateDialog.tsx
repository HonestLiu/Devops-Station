import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from "lucide-react";

import { Bar, Button, Dialog } from "@/components/ui";
import { Markdown } from "@/components/Markdown";
import { useT } from "@/i18n";
import { useUpdaterStore } from "@/store/useUpdaterStore";
import { installUpdate } from "@/lib/updater";

/**
 * Update dialog driven by `useUpdaterStore`. Shows one of three states:
 *   - an update is available (version diff + release notes + download progress),
 *   - already up to date,
 *   - an error (network / signature mismatch / …).
 * The dialog is opened by `checkForUpdate` (startup auto-check or manual button).
 */
export function UpdateDialog() {
  const t = useT();
  const open = useUpdaterStore((s) => s.open);
  const checking = useUpdaterStore((s) => s.checking);
  const update = useUpdaterStore((s) => s.update);
  const downloading = useUpdaterStore((s) => s.downloading);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const total = useUpdaterStore((s) => s.total);
  const error = useUpdaterStore((s) => s.error);
  const setOpen = useUpdaterStore((s) => s.setOpen);

  if (!open) return null;

  const isUpToDate = error === "upToDate";
  const isError = !!error && !isUpToDate;
  const hasUpdate = !!update && !isError;
  const pct = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : downloading ? 100 : 0;

  const close = () => setOpen(false);
  const onInstall = () => {
    void installUpdate();
  };

  return (
    <Dialog open={open} onClose={close} title={t("update.title")}>
      {checking && (
        <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
          <Loader2 size={16} className="animate-spin text-accent" />
          {t("update.checking")}
        </div>
      )}

      {isUpToDate && !checking && (
        <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
          <CheckCircle2 size={18} className="text-emerald-500" />
          {t("update.upToDate")}
        </div>
      )}

      {hasUpdate && !checking && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="text-subtle">{t("update.current")}</span>
            <span className="font-mono text-fg">{update.currentVersion}</span>
            <span className="text-subtle">→</span>
            <span className="font-mono font-semibold text-accent">{update.version}</span>
          </div>

          {update.body && (
            <div>
              <div className="mb-1 text-[12px] font-medium text-subtle">{t("update.notes")}</div>
              <Markdown
                source={update.body.trim()}
                className="max-h-52 overflow-auto rounded-lg border border-border bg-bg p-3 text-[12px] leading-relaxed text-muted"
              />
            </div>
          )}

          {downloading && (
            <div className="flex flex-col gap-1.5">
              <Bar value={pct} tone={pct > 90 ? "success" : "accent"} />
              <div className="text-[11px] text-subtle">
                {t("update.downloading")} {pct}%
                {total > 0 && (
                  <>
                    {" · "}
                    {(downloaded / 1_048_576).toFixed(1)} / {(total / 1_048_576).toFixed(1)} MB
                  </>
                )}
              </div>
            </div>
          )}

          {isError && (
            <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-400">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={close} disabled={downloading}>
              {t("update.later")}
            </Button>
            {!downloading && (
              <Button variant="primary" size="sm" onClick={onInstall} className="gap-1.5">
                <Download size={14} />
                {t("update.install")}
              </Button>
            )}
          </div>
        </div>
      )}

      {isError && !hasUpdate && !checking && (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-400">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={close}>
              {t("common.close")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Small inline control for the About dialog: shows a spinner while checking. */
export function CheckForUpdatesButton() {
  const t = useT();
  const checking = useUpdaterStore((s) => s.checking);
  return (
    <Button
      variant="secondary"
      size="sm"
      className="h-7 gap-1.5"
      disabled={checking}
      onClick={() => {
        void import("@/lib/updater").then((m) => m.checkForUpdate(true));
      }}
    >
      {checking ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      {t("update.checkButton")}
    </Button>
  );
}
