import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  Bluetooth,
  Cable,
  ChevronsRight,
  Columns2,
  Container,
  Copy,
  FolderOpen,
  Globe,
  Hourglass,
  type LucideIcon,
  MessageSquare,
  Microchip,
  Monitor,
  RefreshCw,
  Server,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT, type TKey } from "@/i18n";
import { useTabsStore } from "@/store/useTabsStore";
import { useAppStore } from "@/store/useAppStore";
import { useSessionStore } from "@/store/useSessionStore";
import { useContextMenu, type MenuItem } from "@/store/useContextMenu";
import { Button, Dialog } from "@/components/ui";
import type { Tab, TabKind } from "@/lib/types";

// Distinct glyphs per transport so the tab bar reads at a glance which kind of
// session each tab is. Local / SSH / WSL — the three most common — use clearly
// different shapes (a monitor for "this PC", a server for remote SSH, a
// container for the WSL Linux subsystem) so they are never confused.
const KIND_ICON: Record<TabKind, LucideIcon> = {
  ssh: Server,
  serial: Cable,
  ble: Bluetooth,
  wsl: Container,
  frp: Globe,
  local: Monitor,
  sftp: FolderOpen,
  jlink: Microchip,
  mqtt: MessageSquare,
};

/** i18n key for each tab kind, used as the icon's hover tooltip. */
const KIND_LABEL: Record<TabKind, TKey> = {
  ssh: "tabs.ssh",
  serial: "tabs.serial",
  ble: "tabs.ble",
  wsl: "tabs.wsl",
  frp: "tabs.frpTunnel",
  local: "tabs.local",
  sftp: "tabs.sftp",
  jlink: "tabs.jlink",
  mqtt: "tabs.mqtt",
};

function statusColor(tab: Tab): string {
  switch (tab.status) {
    case "connected":
      return "bg-success";
    case "connecting":
      return "bg-accent";
    case "error":
      return "bg-danger";
    default:
      return "bg-subtle";
  }
}

/**
 * How long a press on a tab must be held before drag-to-split starts, and how
 * far the pointer may wander during the press before it is treated as a plain
 * click/select instead. The tolerance is deliberately generous: a shaky hand
 * or high-resolution trackpad jitters several pixels during a 300ms hold, and
 * we must NOT cancel the split drag for that — only a large, deliberate drag
 * (e.g. selecting tab text) aborts the gesture.
 */
const DRAG_PRESS_MS = 300;
const DRAG_MOVE_TOLERANCE_PX = 40;

/**
 * Drag-to-split via a custom long-press drag (NOT HTML5 DnD — WebView2 shows a
 * 🚫 cursor and drops the payload for in-app HTML5 drags, making them
 * unreliable here). Hold a tab ~300ms, then move: a ghost label follows the
 * cursor; dropping on another tab merges into that tab's split group, dropping
 * anywhere else in the window merges with the currently active terminal.
 */
export function TabBar() {
  const t = useT();
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const setActive = useTabsStore((s) => s.setActive);
  const closeTab = useTabsStore((s) => s.closeTab);
  const duplicateTab = useTabsStore((s) => s.duplicateTab);
  const reconnect = useTabsStore((s) => s.reconnect);
  const groupTabs = useTabsStore((s) => s.groupTabs);
  const waitingBySession = useSessionStore((s) => s.waitingBySession);
  // When set, closing a tab asks for confirmation first (Settings → Confirm
  // before closing a tab) so an accidental ✕ / middle-click / menu click can't
  // kill a live session. Mirrors the browser's "confirm on close" behavior.
  const confirmOnClose = useAppStore((s) => s.settings.confirmOnClose);

  // In-app confirmation dialog state. We use a custom Dialog instead of
  // window.confirm because Tauri's WebView does not reliably surface native
  // confirm() prompts — relying on it made the setting appear to do nothing.
  const [confirmState, setConfirmState] = useState<{
    message: string;
    onConfirm: () => void;
  } | null>(null);

  /** Run `action` either directly (when confirmation is off) or after the user
   * confirms via the in-app dialog. */
  const withCloseConfirm = (message: string, action: () => void) => {
    if (confirmOnClose) {
      setConfirmState({ message, onConfirm: action });
    } else {
      action();
    }
  };

  const isTabWaiting = (tab: Tab): boolean => {
    if (tab.sessionId && waitingBySession[tab.sessionId]) return true;
    return !!tab.panes?.some((p) => p.sessionId && waitingBySession[p.sessionId]);
  };

  const showCtx = useContextMenu((s) => s.show);
  const closeCtx = useContextMenu((s) => s.close);

  // How many tabs share the same host (or kind, when hostless). Used only to
  // decide whether to show the per-host open-index badge: a host opened more
  // than once gets each tab labeled 1 / 2 / 3 … (tab.hostSeq, see the store).
  const tabCountByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const tb of tabs) {
      const key = tb.hostId ?? tb.kind;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [tabs]);

  // --- long-press drag state ------------------------------------------------
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [hoverTabId, setHoverTabId] = useState<string | null>(null);
  // Hover hint bubble: reminds the user to PRESS AND HOLD a tab before dragging
  // (the split drag is long-press based, not HTML5 DnD). Positioned `fixed` so
  // the TabBar's overflow-x-auto can't clip it.
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const pressRef = useRef<{ id: string; x: number; y: number; t: number } | null>(null);
  const dragActiveRef = useRef(false);
  const dragMovedRef = useRef(false);
  const hoverTabIdRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement | null>(null);

  const endDrag = () => {
    pressRef.current = null;
    dragActiveRef.current = false;
    dragMovedRef.current = false;
    hoverTabIdRef.current = null;
    setDragTabId(null);
    setHoverTabId(null);
    ghostRef.current?.remove();
    ghostRef.current = null;
  };

  const showTip = (e: ReactMouseEvent, tab: Tab) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTip({ x: r.left + r.width / 2, y: r.bottom + 6 });
  };
  const hideTip = () => setTip(null);

  const onTabMouseDown = (e: ReactMouseEvent, tab: Tab) => {
    if (e.button !== 0) return;
    // A previous drag may have ended outside the window — always start fresh.
    pressRef.current = { id: tab.id, x: e.clientX, y: e.clientY, t: Date.now() };
    suppressClickRef.current = false;
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const press = pressRef.current;
      if (!press) return;
      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      const dist = Math.hypot(dx, dy);

      if (!dragActiveRef.current) {
        // Before the long-press elapses, only abandon the gesture for a LARGE,
        // deliberate movement — i.e. an actual text selection or click-drag.
        // Tiny jitter during the hold (a shaky hand / high-res trackpad) must
        // NOT cancel the split drag, or the tab would never start splitting.
        if (dist > DRAG_MOVE_TOLERANCE_PX && Date.now() - press.t < DRAG_PRESS_MS) {
          pressRef.current = null;
          return;
        }
        if (Date.now() - press.t < DRAG_PRESS_MS) return;
        // Long-press reached → enter drag mode.
        dragActiveRef.current = true;
        suppressClickRef.current = true;
        setDragTabId(press.id);
        // Only materialize the ghost once the pointer actually moves after the
        // hold, so a still long-press-and-release never flashes a ghost.
        if (dist > 2) {
          const ghost = document.createElement("div");
          ghost.className =
            "pointer-events-none fixed z-[100] flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-[12px] text-fg opacity-90 shadow-xl";
          const title = tabs.find((x) => x.id === press.id)?.title ?? "";
          ghost.textContent = title;
          ghost.style.left = `${e.clientX + 12}px`;
          ghost.style.top = `${e.clientY + 10}px`;
          document.body.appendChild(ghost);
          ghostRef.current = ghost;
        }
      }

      // Follow the cursor. Any real movement past the press point counts as an
      // actual drag (a bare long-press-and-release must NOT merge anything).
      if (dist > 2) dragMovedRef.current = true;
      if (ghostRef.current) {
        ghostRef.current.style.left = `${e.clientX + 12}px`;
        ghostRef.current.style.top = `${e.clientY + 10}px`;
      }

      // Track which tab (if any) is under the cursor. Outside the window the
      // drag is cancelled (a mouseup there would never reach us).
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) {
        endDrag();
        return;
      }
      const tabEl = el?.closest<HTMLElement>("[data-tab-id]");
      const hover = tabEl?.dataset.tabId ?? null;
      hoverTabIdRef.current = hover;
      setHoverTabId(hover);
    };

    const onUp = () => {
      if (dragActiveRef.current && dragMovedRef.current) {
        const src = pressRef.current?.id;
        if (src) {
          const target = hoverTabIdRef.current;
          if (target && target !== src) {
            groupTabs(src, target);
          } else {
            // Dropped on the terminal area / empty space → merge with the
            // currently active terminal.
            const active = useTabsStore.getState().activeId;
            if (active && active !== src) groupTabs(src, active);
          }
        }
      }
      endDrag();
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [groupTabs, tabs]);

  const onTabContextMenu = (e: ReactMouseEvent, tab: Tab) => {
    e.preventDefault();
    e.stopPropagation();
    const idx = tabs.findIndex((t) => t.id === tab.id);
    const items: MenuItem[] = [
      {
        id: "duplicate",
        label: t("tabs.duplicate"),
        icon: <Copy size={14} />,
        onClick: () => {
          closeCtx();
          void duplicateTab(tab.id);
        },
      },
      {
        id: "close",
        label: t("tabs.close"),
        icon: <X size={14} />,
        onClick: () => {
          closeCtx();
          withCloseConfirm(t("tabs.closeConfirm"), () => void closeTab(tab.id));
        },
      },
      {
        id: "close-others",
        label: t("tabs.closeOthers"),
        icon: <X size={14} />,
        onClick: () => {
          closeCtx();
          const others = tabs.filter((t) => t.id !== tab.id);
          if (others.length) {
            withCloseConfirm(t("tabs.closeOthersConfirm", { n: others.length }), () =>
              others.forEach((t) => void closeTab(t.id)),
            );
          }
        },
      },
      {
        id: "close-right",
        label: t("tabs.closeRight"),
        icon: <ChevronsRight size={14} />,
        onClick: () => {
          closeCtx();
          const right = tabs.slice(idx + 1);
          if (right.length) {
            withCloseConfirm(t("tabs.closeOthersConfirm", { n: right.length }), () =>
              right.forEach((t) => void closeTab(t.id)),
            );
          }
        },
      },
    ];
    if (tab.status !== "connected") {
      items.push({ id: "sep", separator: true, label: "" });
      items.push({
        id: "reconnect",
        label: t("tabs.reconnect"),
        icon: <RefreshCw size={14} />,
        onClick: () => {
          closeCtx();
          void reconnect(tab.id);
        },
      });
    }
    showCtx(e.clientX, e.clientY, items);
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border/70 bg-surface px-2 select-none">
      {tabs.map((tab) => {
        const Icon = KIND_ICON[tab.kind];
        const active = tab.id === activeId;
        const dragging = dragTabId === tab.id;
        // Show the open-index badge only when this host/kind is open more than
        // once. The number is tab.hostSeq — its 1-based order among that host's
        // openings (set in the store), so closing a middle tab does not renumber
        // the survivors.
        const showSeq = (tabCountByKey.get(tab.hostId ?? tab.kind) ?? 1) > 1;
        const dropTarget = hoverTabId === tab.id;
        return (
          <div
            key={tab.id}
            data-tab-id={tab.id}
            onMouseDown={(e) => onTabMouseDown(e, tab)}
            // Middle-click closes the tab, just like a browser.
            onMouseUp={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                withCloseConfirm(t("tabs.closeConfirm"), () => void closeTab(tab.id));
              }
            }}
            // Some browsers fire the close on auxclick for the middle button.
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                withCloseConfirm(t("tabs.closeConfirm"), () => void closeTab(tab.id));
              }
            }}
            onMouseEnter={(e) => showTip(e, tab)}
            onMouseLeave={hideTip}
            onClick={() => {
              // Swallow the click that follows a completed drag.
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              setActive(tab.id);
            }}
            onContextMenu={(e) => onTabContextMenu(e, tab)}
            title={
              tab.group
                ? t("tabs.groupedHint")
                : `${t("tabs.dragToSplit")} · ${t("tabs.middleClose")}`
            }
            className={cn(
              "group flex h-7 min-w-[140px] max-w-[220px] cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[12px] transition-colors",
              active
                ? "bg-elevated text-fg shadow-sm ring-1 ring-inset ring-border"
                : "text-muted hover:bg-hover hover:text-fg",
              dropTarget && "ring-2 ring-inset ring-accent",
              dragging && "opacity-40",
            )}
          >
            <span title={t(KIND_LABEL[tab.kind])} className="flex shrink-0 items-center">
              <Icon
                size={13}
                className={cn("shrink-0", active ? "text-accent" : "text-subtle")}
              />
            </span>
            {showSeq && tab.hostSeq != null && (
              <span
                title={t("tabs.hostSeq", { n: tab.hostSeq })}
                className={cn(
                  "flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-medium leading-none",
                  active
                    ? "bg-accent/20 text-accent"
                    : "bg-subtle/30 text-muted",
                )}
              >
                {tab.hostSeq}
              </span>
            )}
            <span className="flex-1 truncate">{tab.title}</span>
            {tab.group && <Columns2 size={11} className="shrink-0 text-accent/70" />}
            {isTabWaiting(tab) && (
              <span title={t("tabs.waitingInput")} className="flex shrink-0 items-center">
                <Hourglass size={12} className="animate-pulse text-warning" />
              </span>
            )}
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                statusColor(tab),
                tab.status === "connecting" && "pulse-dot",
              )}
              title={tab.status}
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                withCloseConfirm(t("tabs.closeConfirm"), () => void closeTab(tab.id));
              }}
              className="shrink-0 rounded p-0.5 text-subtle opacity-0 hover:bg-border hover:text-fg group-hover:opacity-100"
              aria-label={t("tabs.closeAria")}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
      {/* Hover hint: the split drag is long-press based — say so before the
          user tries a quick drag and sees nothing happen. */}
      {tip && !dragActiveRef.current && (
        <div
          className="pointer-events-none fixed z-[90] -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-[11px] text-fg shadow-xl"
          style={{ left: tip.x, top: tip.y }}
        >
          {t("tabs.dragToSplit")}
        </div>
      )}
      <Dialog
        open={confirmState !== null}
        onClose={() => setConfirmState(null)}
        title={t("tabs.closeConfirmTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmState(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const action = confirmState?.onConfirm;
                setConfirmState(null);
                action?.();
              }}
            >
              {t("tabs.close")}
            </Button>
          </>
        }
      >
        {confirmState?.message}
      </Dialog>
    </div>
  );
}
