import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT, type TKey } from "@/i18n";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { permHook } from "@/lib/api";
import type { AgentStatus, PermState, ProjectLight } from "@/lib/types";

function dotClass(s: AgentStatus): string {
  switch (s) {
    case "waitingapproval":
      return "bg-danger";
    case "working":
      return "bg-warning";
    default:
      return "bg-success";
  }
}

function statusLabel(t: (k: TKey, p?: Record<string, string | number>) => string, s: AgentStatus): string {
  switch (s) {
    case "waitingapproval":
      return t("aiStatus.waiting");
    case "working":
      return t("aiStatus.working");
    default:
      return t("aiStatus.resolved");
  }
}

function Row({ light, t }: { light: ProjectLight; t: (k: TKey, p?: Record<string, string | number>) => string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", dotClass(light.status))} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-fg">{light.projectLabel}</div>
        <div className="truncate text-[10px] text-subtle">
          {light.sessions.length} · {statusLabel(t, light.status)}
          {light.sessions.some((s) => s.escalated) ? ` · ${t("aiStatus.escalated")}` : ""}
        </div>
      </div>
      {light.status === "waitingapproval" && (
        <AlertTriangle size={13} className="shrink-0 text-danger" />
      )}
    </div>
  );
}

export function AiStatusWidget() {
  const t = useT();
  const [state, setState] = useState<PermState>({ lights: [] });
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  const pending = state.lights
    .flatMap((l) => l.sessions)
    .filter((s) => s.status === "waitingapproval").length;

  useEffect(() => {
    let un: UnlistenFn | undefined;
    let alive = true;
    void listen<PermState>("perm-state-changed", (e) => {
      if (alive) setState(e.payload);
    }).then((fn) => (un = fn));
    // Seed with the current snapshot.
    void permHook
      .state()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      un?.();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const compute = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (r) setPos({ left: r.right + 8, bottom: window.innerHeight - r.bottom });
    };
    compute();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (btnRef.current && btnRef.current.contains(target)) ||
        (panelRef.current && panelRef.current.contains(target))
      ) {
        return;
      }
      setOpen(false);
      setPos(null);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        title={t("aiStatus.title")}
        className={cn(
          "no-drag flex h-7 w-7 items-center justify-center rounded-md transition-colors",
          pending > 0
            ? "bg-danger/15 text-danger ring-1 ring-inset ring-danger/30"
            : "text-subtle hover:bg-hover hover:text-fg",
        )}
      >
        <Activity size={15} />
        {pending > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">
            {pending > 9 ? "9+" : pending}
          </span>
        )}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={pos ? { left: pos.left, bottom: pos.bottom } : { right: 12, top: 48 }}
            className="fixed z-[100] flex max-h-[70vh] w-72 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
          >
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
              <span className="text-[12px] font-semibold text-fg">{t("aiStatus.title")}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {state.lights.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-subtle">
                  {t("aiStatus.empty")}
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {state.lights.map((l) => (
                    <Row key={l.projectId} light={l} t={t} />
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
