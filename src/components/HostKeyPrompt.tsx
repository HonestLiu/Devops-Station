import { AlertTriangle } from "lucide-react";

import { Button, Dialog } from "@/components/ui";
import { useT } from "@/i18n";
import { useHostKeyStore } from "@/store/useHostKeyStore";

/**
 * Global "trust this unknown host?" modal. The SSH connect flow raises a prompt
 * through `useHostKeyStore.request(...)`; this component renders it and resolves
 * the promise with the user's decision (true = trust & reconnect).
 */
export function HostKeyPrompt() {
  const t = useT();
  const prompt = useHostKeyStore((s) => s.prompt);
  const respond = useHostKeyStore((s) => s.respond);

  return (
    <Dialog
      open={!!prompt}
      onClose={() => respond(false)}
      title={t("hk.title")}
      width="max-w-md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={() => respond(false)}>
            {t("hk.cancel")}
          </Button>
          <Button variant="danger" size="sm" onClick={() => respond(true)}>
            {t("hk.trust")}
          </Button>
        </>
      }
    >
      {prompt && (
        <div className="flex flex-col gap-3">
          {prompt.mismatch && (
            <div className="flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-[12px] text-danger">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{t("hk.mismatch")}</span>
            </div>
          )}
          {!prompt.mismatch && (
            <p className="text-[12px] text-muted">{t("hk.unknown")}</p>
          )}

          <p className="font-mono text-[12px] text-fg">
            {t("hk.host", { host: prompt.host, port: prompt.port })}
          </p>
          <p className="break-all font-mono text-[11px] text-subtle">
            {t("hk.body", { fp: prompt.fingerprint })}
          </p>
        </div>
      )}
    </Dialog>
  );
}
