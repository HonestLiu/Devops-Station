import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useContextMenu, type MenuItem } from "@/store/useContextMenu";

/**
 * The single, app-wide right-click menu. Every surface opens it through the
 * `useContextMenu` store (show/close); native context menus are suppressed at
 * the app root so this is the only menu the user ever sees.
 *
 * Items may nest arbitrarily deep via `submenu` (each level rendered as a
 * flyout on hover) and may carry a `header` flag to render a non-clickable
 * group label inside a submenu.
 * Closes on: outside click, Escape, scroll, and window resize. Repositions
 * itself to stay inside the viewport when opened near an edge.
 */
export function ContextMenu() {
  const open = useContextMenu((s) => s.open);
  const x = useContextMenu((s) => s.x);
  const y = useContextMenu((s) => s.y);
  const items = useContextMenu((s) => s.items);
  const close = useContextMenu((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  // Measured size of the menu. Starts at 0 so the very first paint places the
  // menu at the raw cursor coordinates — when size is 0 the clamp resolves to
  // (x, y), so the menu never briefly appears at a stale corner on first open.
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Path of the currently hovered submenu, e.g. "snippets/git/commit". A null
  // path means no submenu is open. Stored as a path (not a single id) so a
  // submenu can stay open while one of its descendants is hovered — this is what
  // allows arbitrarily deep nesting.
  const [openSub, setOpenSub] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    // A freshly opened menu starts with no submenu expanded.
    setOpenSub(null);
    const el = ref.current;
    if (!el) return;
    setSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [open, items]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onScrollOrResize = () => close();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close]);

  if (!open) return null;

  const MARGIN = 8;
  // Derive the clamped position during render from the live cursor coords. With
  // size starting at 0, the first paint lands exactly at the cursor; once the
  // menu is measured the layout effect tightens it against the viewport edges.
  const left = Math.max(MARGIN, Math.min(x, window.innerWidth - size.w - MARGIN));
  const top = Math.max(MARGIN, Math.min(y, window.innerHeight - size.h - MARGIN));

  const renderItem = (it: MenuItem, key: string | number, path = "", inSubmenu = false) => {
    // Full slash-joined path from the menu root, used as the expand key so two
    // groups in different branches never collide and we can tell ancestors from
    // descendants.
    const fullPath = path ? `${path}/${it.id}` : it.id;
    if (it.separator) {
      return <div key={key} className="my-1 h-px bg-border" />;
    }
    if (it.header) {
      return (
        <div
          key={key}
          className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-subtle"
        >
          {it.label}
        </div>
      );
    }
    const isSubmenu = !!it.submenu?.length;
    if (isSubmenu) {
      // Open when this item is the exact hovered node, OR when one of its
      // descendants is hovered (so the whole branch stays visible as you go
      // deeper). The trailing slash prevents "git" from matching "github".
      const subOpen =
        openSub === fullPath ||
        (openSub !== null && openSub.startsWith(`${fullPath}/`));
      return (
        <div
          key={key}
          className="relative"
          onMouseEnter={() => setOpenSub(fullPath)}
        >
          <button
            type="button"
            role="menuitem"
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-hover",
            )}
            onClick={() => setOpenSub((cur) => (cur === fullPath ? null : fullPath))}
          >
            {it.icon && (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {it.icon}
              </span>
            )}
            <span className="flex-1 truncate">{it.label}</span>
            <ChevronRight size={12} className="shrink-0 text-subtle" />
          </button>
          {subOpen && (
            <div className="absolute left-full top-0 z-[110] min-w-[180px] overflow-visible rounded-lg border border-border bg-elevated py-1 shadow-xl">
              {it.submenu!.map((s, j) => renderItem(s, `${key}-${j}`, fullPath, true))}
            </div>
          )}
        </div>
      );
    }
    return (
      <button
        key={key}
        type="button"
        role="menuitem"
        disabled={it.disabled}
        // Only a top-level plain item should dismiss an open submenu branch.
        // Items *inside* a submenu must not close the branch they belong to.
        onMouseEnter={inSubmenu ? undefined : () => setOpenSub(null)}
        onClick={() => {
          close();
          it.onClick?.();
        }}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors",
          it.disabled
            ? "cursor-not-allowed text-subtle"
            : it.danger
              ? "text-danger hover:bg-danger/10"
              : "text-fg hover:bg-hover",
        )}
      >
        {it.icon && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center">{it.icon}</span>
        )}
        <span className="flex-1 truncate">{it.label}</span>
        {it.shortcut && (
          <span className="ml-3 shrink-0 text-[10px] text-subtle">{it.shortcut}</span>
        )}
      </button>
    );
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[100] min-w-[180px] overflow-visible rounded-lg border border-border bg-elevated py-1 shadow-xl"
      style={{ left, top }}
    >
      {items.map((it, i) => renderItem(it, i))}
    </div>,
    document.body,
  );
}
