import { AlertTriangle, Loader2, RotateCw } from "lucide-react";

import { Button } from "@/components/ui";
import { useTabsStore } from "@/store/useTabsStore";
import type { Tab } from "@/lib/types";

/**
 * Cover shown over a workspace while it's connecting or after it failed. Once
 * the tab reaches `connected`, render `null` and let the live surface show.
 *
 * Absolutely positioned on purpose. It used to be a plain in-flow block, which
 * worked only by accident: SSH/local hide their terminal while disconnected, so
 * the overlay was the sole child. The serial workspace keeps its Normal-mode log
 * mounted at `h-full`, so the overlay stacked *below* it and scrolled clean out
 * of view — the port would die and you'd stare at a stale log with no error and
 * a silently dead send bar. Covering the surface makes the failure impossible to
 * miss. Every call site already wraps this in a `relative` container.
 */
export function ConnectionOverlay({ tab }: { tab: Tab }) {
  const reconnect = useTabsStore((s) => s.reconnect);

  if (tab.status === "connecting") {
    return (
      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-bg">
        <Loader2 size={28} className="animate-spin text-accent" />
        <p className="text-[13px] text-muted">Connecting to {tab.title}…</p>
      </div>
    );
  }

  if (tab.status === "error" || tab.status === "closed") {
    return (
      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-bg/95 px-6 text-center backdrop-blur-sm">
        <AlertTriangle size={28} className="text-danger" />
        <p className="text-[13px] font-medium text-fg">
          {tab.status === "closed" ? "Connection closed" : "Connection failed"}
        </p>
        {tab.error && (
          <p className="max-w-md break-words text-[12px] text-muted">{tab.error}</p>
        )}
        <Button variant="primary" size="sm" onClick={() => void reconnect(tab.id)}>
          <RotateCw size={13} />
          Reconnect
        </Button>
      </div>
    );
  }

  return null;
}
