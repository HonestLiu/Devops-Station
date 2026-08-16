import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";

import { Badge, Button, Dialog } from "@/components/ui";
import { useT } from "@/i18n";
import { ssh } from "@/lib/api";
import type { KnownHostEntry } from "@/lib/types";

/** Unix seconds → locale string (timestamps are stored as seconds). */
function fmt(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleString();
}

export function KnownHostsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const [entries, setEntries] = useState<KnownHostEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await ssh.knownHostsList());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const remove = async (host: string, port: number) => {
    if (!window.confirm(t("kh.removeConfirm", { host, port }))) return;
    try {
      await ssh.knownHostsRemove(host, port);
    } catch (e) {
      setError(t("kh.removeError", { msg: (e as Error).message }));
    }
    await refresh();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("kh.title")}
      description={t("kh.subtitle")}
      width="max-w-lg"
    >
      {loading && <p className="text-[12px] text-subtle">{t("ws.statusConnecting")}</p>}
      {error && <p className="text-[12px] text-danger">{error}</p>}
      {!loading && !error && entries.length === 0 && (
        <p className="text-[12px] text-subtle">{t("kh.noEntries")}</p>
      )}

      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li
            key={`${e.host}:${e.port}`}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-bg px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-mono text-[12px] font-medium text-fg">
                  {e.host}:{e.port}
                </span>
                <Badge tone="neutral">{e.keyType}</Badge>
              </div>
              <p className="mt-0.5 truncate font-mono text-[11px] text-subtle" title={e.fingerprint}>
                {e.fingerprint}
              </p>
              <p className="mt-0.5 text-[11px] text-subtle">
                {t("kh.firstSeen")}: {fmt(e.firstSeen)} · {t("kh.lastSeen")}: {fmt(e.lastSeen)}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => void remove(e.host, e.port)}
              title={t("kh.remove")}
            >
              <Trash2 size={14} />
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
