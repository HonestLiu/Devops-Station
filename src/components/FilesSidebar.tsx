import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
  Home,
  LocateFixed,
  Play,
  RefreshCw,
  X,
} from "lucide-react";

import { cn, textToBase64 } from "@/lib/utils";
import { localFs, pty } from "@/lib/api";
import type { LocalEntry, Tab } from "@/lib/types";
import { useTabsStore } from "@/store/useTabsStore";
import { useSessionStore } from "@/store/useSessionStore";
import { Button, Input } from "@/components/ui";

// --- path helpers ----------------------------------------------------------

function basename(p: string): string {
  const norm = p.replace(/[\\/]$/, "");
  const idx = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return idx < 0 ? norm : norm.slice(idx + 1);
}

function parentOf(p: string): string | null {
  const norm = p.replace(/[\\/]$/, "");
  const idx = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  if (idx <= 0) return null;
  return norm.slice(0, idx) || null;
}

/** The drive/volume root of a path, e.g. `C:\Users\Hones` -> `C:\`. Used as a
 *  stable anchor so the tree can expand the whole ancestor chain down to the
 *  shell's cwd instead of diving into a flat one-level listing. */
function driveRoot(p: string): string {
  const norm = p.replace(/[\\/]$/, "");
  const idx = Math.max(norm.indexOf("\\"), norm.indexOf("/"));
  if (idx <= 0) return norm || p;
  return norm.slice(0, idx + 1);
}

function quotePath(p: string): string {
  return `"${p.replace(/"/g, '\\"')}"`;
}

/** Normalize a path for comparison: forward slashes, no trailing slash, lowercase
 *  (so Windows `C:\Users` and `c:/users` compare equal). */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when `ancestor` is `child` itself or a parent directory of it. */
function isAncestor(ancestor: string, child: string): boolean {
  const a = normalizePath(ancestor);
  const c = normalizePath(child);
  return c === a || c.startsWith(a + "/");
}

/**
 * Send a `cd` into this panel's terminal tab. For a local/WSL shell we change
 * its directory in place; otherwise we open a fresh Local Shell at that path so
 * the action always does something useful. Mirrors how the WSL panel is bound to
 * its own session rather than the global active one.
 */
function cdInto(tab: Tab, path: string) {
  if ((tab.kind === "local" || tab.kind === "wsl") && tab.sessionId) {
    void pty.write(tab.sessionId, textToBase64(`cd ${quotePath(path)}\r`));
  } else {
    void useTabsStore.getState().openLocal(path);
  }
}

// --- small UI atoms --------------------------------------------------------

function RowHint({ depth, text, danger }: { depth: number; text: string; danger?: boolean }) {
  return (
    <div
      className={cn("px-2 py-1 text-[11px]", danger ? "text-danger" : "text-subtle")}
      style={{ paddingLeft: `${depth * 12 + 16}px` }}
    >
      {text}
    </div>
  );
}

// --- file row --------------------------------------------------------------

function FileRow({
  entry,
  depth,
  selected,
  onSelect,
}: {
  entry: LocalEntry;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData("text/plain", entry.path)}
      onClick={onSelect}
      onDoubleClick={() => void localFs.open(entry.path)}
      title={entry.path}
      className={cn(
        "group flex cursor-pointer items-center gap-1 border-b border-border/50 py-1 text-[12px] hover:bg-hover",
        selected && "bg-accent/10",
      )}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      <span className="w-4 shrink-0" />
      <FileIcon size={14} className="shrink-0 text-subtle" />
      <span className="truncate font-mono text-fg">{entry.name}</span>
      <div className="ml-auto hidden items-center gap-0.5 pr-1 group-hover:flex">
        <button
          type="button"
          title="Open in default app"
          onClick={(e) => {
            e.stopPropagation();
            void localFs.open(entry.path);
          }}
          className="rounded p-1 text-muted hover:bg-bg hover:text-fg"
        >
          <Play size={12} />
        </button>
        <button
          type="button"
          title="Reveal in file manager"
          onClick={(e) => {
            e.stopPropagation();
            void localFs.reveal(entry.path);
          }}
          className="rounded p-1 text-muted hover:bg-bg hover:text-fg"
        >
          <ExternalLink size={12} />
        </button>
      </div>
    </div>
  );
}

// --- directory node (recursive) -------------------------------------------

function DirNode({
  tab,
  path,
  name,
  depth,
  defaultOpen = false,
  reload = 0,
  selectedPath,
  setSelectedPath,
  cwd,
  follow,
}: {
  tab: Tab;
  path: string;
  name: string;
  depth: number;
  defaultOpen?: boolean;
  reload?: number;
  selectedPath: string | null;
  setSelectedPath: (p: string) => void;
  cwd: string | null;
  follow: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const [children, setChildren] = useState<LocalEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // When "follow terminal" is on, auto-open any ancestor of the shell's cwd so the
  // current directory is always revealed in the tree.
  const shouldOpen = follow && cwd != null && (cwd === path || isAncestor(path, cwd));
  useEffect(() => {
    if (shouldOpen) setExpanded(true);
  }, [shouldOpen]);

  // Scroll the shell's *current* directory into view so it's obvious where the
  // terminal is, without the user having to hunt for it in a deep tree.
  useEffect(() => {
    if (follow && cwd != null && normalizePath(cwd) === normalizePath(path)) {
      rowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [follow, cwd, path, expanded]);

  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    setLoading(true);
    setError(null);
    localFs
      .list(path)
      .then((entries) => {
        if (alive) setChildren(entries);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [expanded, path, reload]);

  return (
    <div>
      <div
        ref={rowRef}
        draggable
        onDragStart={(e) => e.dataTransfer.setData("text/plain", path)}
        onClick={() => {
          setSelectedPath(path);
          setExpanded((v) => !v);
          cdInto(tab, path);
        }}
        title={path}
        className={cn(
          "group flex cursor-pointer items-center gap-1 border-b border-border/50 py-1 text-[12px] hover:bg-hover",
          selectedPath != null && normalizePath(selectedPath) === normalizePath(path) && "bg-accent/10",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="no-drag flex h-4 w-4 shrink-0 items-center justify-center text-subtle hover:text-fg"
        >
          <ChevronRight
            size={13}
            className={cn("transition-transform", expanded && "rotate-90")}
          />
        </button>
        {expanded ? (
          <FolderOpen size={14} className="shrink-0 text-accent" />
        ) : (
          <Folder size={14} className="shrink-0 text-accent" />
        )}
        <span className="truncate font-mono text-fg">{name}</span>
        <div className="ml-auto hidden items-center gap-0.5 pr-1 group-hover:flex">
          <button
            type="button"
            title="Reveal in file manager"
            onClick={(e) => {
              e.stopPropagation();
              void localFs.reveal(path);
            }}
            className="rounded p-1 text-muted hover:bg-bg hover:text-fg"
          >
            <ExternalLink size={12} />
          </button>
        </div>
      </div>

      {expanded && (
        <div>
          {loading && <RowHint depth={depth + 1} text="Loading…" />}
          {error && <RowHint depth={depth + 1} text={error} danger />}
          {children && children.length === 0 && <RowHint depth={depth + 1} text="(empty)" />}
          {children?.map((c) =>
            c.isDir ? (
              <DirNode
                key={`${c.path}:${reload}`}
                tab={tab}
                path={c.path}
                name={c.name}
                depth={depth + 1}
                reload={reload}
                selectedPath={selectedPath}
                setSelectedPath={setSelectedPath}
                cwd={cwd}
                follow={follow}
              />
            ) : (
              <FileRow
                key={`${c.path}:${reload}`}
                entry={c}
                depth={depth + 1}
                selected={
                  selectedPath != null && normalizePath(selectedPath) === normalizePath(c.path)
                }
                onSelect={() => setSelectedPath(c.path)}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// --- sidebar shell ---------------------------------------------------------

export function FilesSidebar({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  // The local Files panel browses the *host* filesystem via localFs.*. Following
  // the shell's cwd only makes sense for a local shell — for an SSH/WSL session
  // the cwd is a *remote* path (e.g. /home/user) that doesn't exist on the host,
  // and listing it locally throws "no such directory". The remote panels (SFTP /
  // WSL) are the right tool for those sessions, so we never follow remote cwds.
  const isLocal = tab.kind === "local";
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [reload, setReload] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [follow, setFollow] = useState(isLocal);

  // Live working directory of *this* tab's shell (updated by the OSC 7 hook as
  // the user `cd`s). Null until the first OSC 7 report arrives.
  const liveCwd = useSessionStore((s) =>
    tab.sessionId ? s.cwdBySession[tab.sessionId] : undefined,
  );

  useEffect(() => {
    let alive = true;
    localFs.home().then((h) => {
      if (!alive) return;
      setRootPath(h);
      setAddress(h);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Follow the terminal's working directory: keep the tree rooted so the cwd is
  // visible, highlight it, and mirror it in the address bar. Pausing (`follow`
  // off) lets the user browse freely without the view snapping back on every cd.
  useEffect(() => {
    if (!follow || !isLocal) return;
    if (liveCwd) {
      setSelectedPath(liveCwd);
      setAddress(liveCwd);
      setRootPath((prev) => {
        if (!prev) return prev; // wait for the initial home() load
        if (prev === liveCwd || isAncestor(prev, liveCwd)) return prev;
        // cwd escaped the current root — anchor at the drive root so the whole
        // ancestor chain stays visible and the cwd is revealed as an *expanded*
        // node (context preserved), instead of diving into a flat one-level list.
        return driveRoot(liveCwd);
      });
    } else if (rootPath) {
      setAddress(rootPath);
    }
  }, [liveCwd, follow, rootPath]);

  const goUp = () => {
    if (!rootPath) return;
    const parent = parentOf(rootPath);
    if (parent) {
      setRootPath(parent);
      setAddress(parent);
      setReload((r) => r + 1);
    }
  };
  const goHome = () => {
    void localFs.home().then((h) => {
      setRootPath(h);
      setAddress(h);
      setReload((r) => r + 1);
    });
  };
  const navigate = (raw: string) => {
    const p = raw.trim();
    if (!p) return;
    setRootPath(p);
    setAddress(p);
    setReload((r) => r + 1);
  };

  return (
    <aside className="relative flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface">
      {/* Path / actions bar — mirrors the Wsl/Sftp panel's top bar */}
      <div className="flex h-9 items-center gap-1 border-b border-border px-2.5">
        <Button variant="ghost" size="sm" onClick={goHome} title="Home">
          <Home size={14} />
        </Button>
        <Button variant="ghost" size="sm" onClick={goUp} title="Up">
          <ArrowUp size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReload((r) => r + 1)}
          title="Refresh"
        >
          <RefreshCw size={14} />
        </Button>
        <Button
          variant={follow ? "primary" : "secondary"}
          size="sm"
          onClick={() => setFollow((v) => !v)}
          disabled={!isLocal}
          title={
            !isLocal
              ? "Follow only works for local shells — use the SFTP / WSL panel for remote files"
              : follow
                ? "Following the terminal's directory — click to pause"
                : "Paused — click to follow the terminal's directory"
          }
        >
          <LocateFixed size={13} />
          {follow ? "Following" : "Follow"}
        </Button>
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(address);
          }}
          spellCheck={false}
          placeholder="path or browse…"
          className="h-7 flex-1 px-2 font-mono text-[11px]"
        />
        <Button variant="ghost" size="sm" onClick={() => onClose()} title="Close Files">
          <X size={14} />
        </Button>
      </div>

      {/* tree */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {rootPath ? (
          <DirNode
            key={`${rootPath}:${reload}`}
            tab={tab}
            path={rootPath}
            name={basename(rootPath) || rootPath}
            depth={0}
            defaultOpen
            reload={reload}
            selectedPath={selectedPath}
            setSelectedPath={setSelectedPath}
            cwd={isLocal ? liveCwd ?? null : null}
            follow={follow}
          />
        ) : (
          <p className="px-3 py-2 text-[12px] text-subtle">Loading…</p>
        )}
      </div>

      <div className="border-t border-border px-3 py-2 text-[10px] leading-relaxed text-subtle">
        Click a folder to <span className="text-fg">cd</span> the terminal into it. The panel
        follows your <span className="text-fg">cd</span>s when the link is active. Drag a file
        onto the terminal to insert its path.
      </div>
    </aside>
  );
}
