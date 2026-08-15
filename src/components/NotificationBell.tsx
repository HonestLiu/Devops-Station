import { useEffect, useRef, useState } from "react";
import { ArrowRight, Bell, BellRing, Check, ShieldCheck, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT, type TKey } from "@/i18n";
import { usePermStore, type PermItem } from "@/store/usePermStore";
import { useTabsStore } from "@/store/useTabsStore";
import { approveSession } from "@/lib/quickApprove";

function timeAgo(
  t: (key: TKey, params?: Record<string, string | number>) => string,
  ts: number,
): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return t("perm.justNow");
  if (s < 60) return t("perm.secsAgo", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("perm.minsAgo", { n: m });
  return t("perm.hoursAgo", { n: Math.floor(m / 60) });
}

function Row({ item }: { item: PermItem }) {
  const t = useT();
  const focusBySession = useTabsStore((s) => s.focusBySession);
  const dismiss = usePermStore((s) => s.dismiss);

  // HOOK events carry the agent's own session id, which no local tab owns —
  // target the linked local session when we have one.
  const localSid = item.targetSessionId ?? item.sessionId;

  const jump = () => {
    focusBySession(localSid);
    dismiss(item.id);
  };

  const approve = () => {
    // Send Enter to the waiting session (confirms the highlighted "Yes" option),
    // then drop the entry so the bell reflects it as handled.
    void approveSession(localSid);
    dismiss(item.id);
  };

  return (
    <div className="group flex flex-col gap-1 rounded-lg border border-border/70 bg-elevated px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <ShieldCheck size={13} className="shrink-0 text-accent" />
        <span className="flex-1 truncate text-[12px] font-semibold text-fg">{item.tool}</span>
        <span className="shrink-0 text-[10px] text-subtle">{timeAgo(t, item.ts)}</span>
        <button
          onClick={() => dismiss(item.id)}
          className="shrink-0 rounded p-0.5 text-subtle opacity-0 transition-opacity hover:bg-border hover:text-fg group-hover:opacity-100"
          title={t("perm.dismiss")}
        >
          <X size={12} />
        </button>
      </div>
      <p className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted">
        {item.snippet}
      </p>
      <div className="mt-0.5 grid grid-cols-2 gap-1.5">
        <button
          onClick={approve}
          title={t("perm.approveHint")}
          className="flex items-center justify-center gap-1 rounded-md bg-accent/15 py-1 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25"
        >
          <Check size={12} /> {t("perm.approve")}
        </button>
        <button
          onClick={jump}
          className="flex items-center justify-center gap-1 rounded-md bg-hover py-1 text-[11px] font-medium text-muted transition-colors hover:bg-border hover:text-fg"
        >
          {t("perm.jumpToTerminal")} <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
}

export function NotificationBell() {
  const t = useT();
  const items = usePermStore((s) => s.items);
  const unseen = usePermStore((s) => s.unseen);
  const markSeen = usePermStore((s) => s.markSeen);
  const clear = usePermStore((s) => s.clear);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Auto-expire stale entries so the badge count stays honest.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const cur = usePermStore.getState().items;
      const live = cur.filter((i) => now - i.ts < 3 * 60_000);
      if (live.length !== cur.length) usePermStore.setState({ items: live });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, []);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      if (next) markSeen();
      return next;
    });
  };

  const hasItems = items.length > 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        title={t("perm.title")}
        className={cn(
          "no-drag flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
          unseen > 0
            ? "bg-accent/15 text-accent ring-1 ring-inset ring-accent/30"
            : "text-subtle hover:bg-hover hover:text-fg",
        )}
      >
        {unseen > 0 ? <BellRing size={15} /> : <Bell size={15} />}
        {unseen > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-accent-fg">
            {unseen > 9 ? "9+" : unseen}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute bottom-0 left-full z-50 ml-2 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
          <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
            <span className="text-[12px] font-semibold text-fg">{t("perm.title")}</span>
            {hasItems && (
              <button
                onClick={clear}
                className="text-[10px] text-subtle transition-colors hover:text-danger"
              >
                {t("perm.clearAll")}
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {hasItems ? (
              <div className="flex flex-col gap-1.5">
                {items.map((it) => (
                  <Row key={it.id} item={it} />
                ))}
              </div>
            ) : (
              <p className="px-2 py-6 text-center text-[11px] text-subtle">{t("perm.empty")}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
