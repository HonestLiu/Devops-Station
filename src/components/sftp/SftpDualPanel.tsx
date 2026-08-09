import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  ArrowUp,
  ArrowLeftRight,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderPlus,
  Home,
  LocateFixed,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";

import { sftp } from "@/lib/api";
import { localFs } from "@/lib/api";
import { Bar, Button } from "@/components/ui";
import { cn, formatBytes, formatMtime, parentPath } from "@/lib/utils";
import { explainFile, diffFiles } from "@/ai/tasks";
import { useSessionStore } from "@/store/useSessionStore";
import type { LocalEntry, RemoteFile, TransferProgress } from "@/lib/types";

interface DragItem {
  side: "remote" | "local";
  path: string;
  name: string;
  isDir: boolean;
}

interface DragState {
  item: DragItem;
  x: number;
  y: number;
  /** True once the pointer moved past the threshold (a real drag, not a click). */
  active: boolean;
  /** Pane currently hovered while dragging. */
  over: "remote" | "local" | null;
  /** Folder row currently hovered while dragging (takes priority on drop). */
  overFolder: { side: "remote" | "local"; path: string } | null;
}

/**
 * Dual-pane SFTP file manager: the left pane browses the connected remote host,
 * the right pane browses the local machine.
 *
 * Drag & drop is implemented with raw mouse events (mousedown → move past a
 * threshold → floating preview → mouseup) instead of HTML5 `draggable`:
 * WebView2 + Tauri's OS drag-drop handling makes HTML5 DnD unreliable (no-drop
 * cursor, empty dataTransfer), and a mouse-based drag works identically
 * everywhere. Drop targets are detected via onMouseEnter/onMouseLeave.
 */
export function SftpDualPanel({ sessionId }: { sessionId: string }) {
  // --- Remote pane state ---
  const [rPath, setRPath] = useState("/");
  const [rFiles, setRFiles] = useState<RemoteFile[]>([]);
  const [rLoading, setRLoading] = useState(true);
  const [rError, setRError] = useState<string | undefined>();
  const [rShowHidden, setRShowHidden] = useState(false);
  const [rSelected, setRSelected] = useState<string | undefined>();
  const [autoFollow, setAutoFollow] = useState(true);
  const remoteCwd = useSessionStore((s) => s.cwdBySession[sessionId]);
  const rPathRef = useRef(rPath);
  rPathRef.current = rPath;

  // --- Local pane state ---
  const [lPath, setLPath] = useState("");
  const [lFiles, setLFiles] = useState<LocalEntry[]>([]);
  const [lLoading, setLLoading] = useState(true);
  const [lError, setLError] = useState<string | undefined>();
  const [lShowHidden, setLShowHidden] = useState(false);
  const [lSelected, setLSelected] = useState<string | undefined>();
  const lPathRef = useRef(lPath);
  lPathRef.current = lPath;

  // --- Shared transfer + drag state ---
  const [transfers, setTransfers] = useState<Record<string, TransferProgress>>({});
  const transferSide = useRef<Record<string, "remote" | "local">>({});
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [osDrag, setOsDrag] = useState(false);

  const loadRemote = useCallback(
    async (p: string) => {
      setRLoading(true);
      setRError(undefined);
      try {
        const list = await sftp.list(sessionId, p);
        setRFiles(list);
        setRPath(p);
        setRSelected(undefined);
      } catch (e) {
        setRError((e as Error).message);
      } finally {
        setRLoading(false);
      }
    },
    [sessionId],
  );

  const loadLocal = useCallback(async (p: string) => {
    setLLoading(true);
    setLError(undefined);
    try {
      const list = await localFs.list(p);
      setLFiles(list);
      setLPath(p);
      setLSelected(undefined);
    } catch (e) {
      setLError((e as Error).message);
    } finally {
      setLLoading(false);
    }
  }, []);

  // Initial loads: remote home via realpath("."), local home via env.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const home = await sftp.realpath(sessionId, ".").catch(() => "/");
        if (cancelled) return;
        const list = await sftp.list(sessionId, home);
        if (cancelled) return;
        setRFiles(list);
        setRPath(home);
      } catch (e) {
        if (!cancelled) setRError((e as Error).message);
      } finally {
        if (!cancelled) setRLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const home = await localFs.home();
        if (cancelled) return;
        const list = await localFs.list(home);
        if (cancelled) return;
        setLFiles(list);
        setLPath(home);
      } catch (e) {
        if (!cancelled) setLError((e as Error).message);
      } finally {
        if (!cancelled) setLLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-follow the terminal's remote cwd (like the classic panel).
  useEffect(() => {
    if (autoFollow && remoteCwd && remoteCwd !== rPathRef.current) {
      void loadRemote(remoteCwd);
    }
  }, [remoteCwd, autoFollow, loadRemote]);

  // Transfer progress; reload the affected pane when a transfer finishes.
  useEffect(() => {
    const un = sftp.onProgress((p) => {
      setTransfers((prev) => ({ ...prev, [p.transferId]: p }));
      if (p.done) {
        const tid = p.transferId;
        const side = transferSide.current[tid];
        window.setTimeout(() => {
          setTransfers((prev) => {
            const next = { ...prev };
            delete next[tid];
            delete transferSide.current[tid];
            return next;
          });
          if (side === "remote") void loadRemote(rPathRef.current);
          else if (side === "local") void loadLocal(lPathRef.current);
        }, 500);
      }
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, [loadRemote, loadLocal]);

  // --- Transfers ---
  const startUpload = (localPath: string, remoteDir: string) => {
    const id = crypto.randomUUID();
    const name = localPath.split(/[\\/]/).pop() ?? "file";
    transferSide.current[id] = "remote";
    setTransfers((prev) => ({
      ...prev,
      [id]: { transferId: id, fileName: name, transferred: 0, total: 0, done: false },
    }));
    void sftp.upload(sessionId, localPath, remoteDir, id).catch((e) => {
      setTransfers((prev) => ({
        ...prev,
        [id]: { transferId: id, fileName: name, transferred: 0, total: 0, done: true, error: (e as Error).message },
      }));
    });
  };

  const startDownload = (remotePath: string, name: string, localDir: string) => {
    const id = crypto.randomUUID();
    transferSide.current[id] = "local";
    setTransfers((prev) => ({
      ...prev,
      [id]: { transferId: id, fileName: name, transferred: 0, total: 0, done: false },
    }));
    void sftp
      .download(sessionId, remotePath, joinLocal(localDir, name), id)
      .catch((e) => {
        setTransfers((prev) => ({
          ...prev,
          [id]: { transferId: id, fileName: name, transferred: 0, total: 0, done: true, error: (e as Error).message },
        }));
      });
  };

  // --- Custom mouse drag & drop (no HTML5 DnD — WebView2-safe) ---
  const patchDrag = (patch: Partial<DragState>) => {
    if (!dragRef.current) return;
    const next = { ...dragRef.current, ...patch };
    dragRef.current = next;
    setDrag(next);
  };

  const commitDrop = (d: DragState) => {
    const target = d.overFolder
      ? d.overFolder
      : d.over
        ? { side: d.over, path: d.over === "remote" ? rPathRef.current : lPathRef.current }
        : null;
    if (!target) return;
    if (d.item.side === target.side) return; // same side — nothing to transfer
    if (target.side === "remote") startUpload(d.item.path, target.path);
    else startDownload(d.item.path, d.item.name, target.path);
  };

  const startRowDrag = (e: ReactMouseEvent, item: DragItem) => {
    if (e.button !== 0 || item.isDir) return;
    // Don't hijack the row action buttons (download / rename / delete).
    if ((e.target as HTMLElement).closest("button")) return;

    const sx = e.clientX;
    const sy = e.clientY;
    dragRef.current = { item, x: sx, y: sy, active: false, over: null, overFolder: null };
    setDrag(dragRef.current);
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!moved) {
        moved = true;
        suppressClick.current = true;
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      const next = { ...dragRef.current!, x: ev.clientX, y: ev.clientY, active: true };
      dragRef.current = next;
      setDrag(next);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (moved && d) commitDrop(d);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // OS-level file drop anywhere on the window uploads to the remote pane.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      const p = getCurrentWebview().onDragDropEvent((event) => {
        const e = event.payload;
        if (e.type === "drop") {
          setOsDrag(false);
          for (const localPath of e.paths) startUpload(localPath, rPathRef.current);
        } else if (e.type === "leave") {
          setOsDrag(false);
        } else {
          setOsDrag(true);
        }
      });
      p.then((fn) => {
        if (cancelled) fn();
        else un = fn;
      });
    });
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  // --- Actions ---
  const uploadHere = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: true, title: "Select files to upload" });
      if (!picked) return;
      for (const p of Array.isArray(picked) ? picked : [picked]) startUpload(p, rPath);
    } catch {
      alert("File pickers require the desktop app.");
    }
  };

  const newRemoteFolder = async () => {
    const name = window.prompt("New folder name");
    if (!name) return;
    try {
      await sftp.mkdir(sessionId, `${rPath === "/" ? "" : rPath}/${name}`);
      void loadRemote(rPath);
    } catch (e) {
      setRError((e as Error).message);
    }
  };

  const doRenameRemote = async (f: RemoteFile) => {
    const next = window.prompt("Rename to", f.name);
    if (!next || next === f.name) return;
    const to = `${rPath === "/" ? "" : rPath}/${next}`;
    try {
      await sftp.rename(sessionId, f.path, to);
      void loadRemote(rPath);
    } catch (e) {
      setRError((e as Error).message);
    }
  };

  const doDeleteRemote = async (f: RemoteFile) => {
    if (!window.confirm(`Delete ${f.isDir ? "folder" : "file"} "${f.name}"?`)) return;
    try {
      await sftp.remove(sessionId, f.path, f.isDir);
      void loadRemote(rPath);
    } catch (e) {
      setRError((e as Error).message);
    }
  };

  const rVisible = rShowHidden ? rFiles : rFiles.filter((f) => !f.name.startsWith("."));
  const lVisible = lShowHidden ? lFiles : lFiles.filter((f) => !f.name.startsWith("."));
  const activeTransfers = Object.values(transfers);

  // Shared row props for a pane's file rows.
  const rowDragProps = (item: DragItem, folderHover: { side: "remote" | "local"; path: string } | null) => ({
    onMouseDown: (e: ReactMouseEvent) => startRowDrag(e, item),
    onClick: () => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      if (item.side === "remote") {
        setRSelected(item.path === rSelected ? undefined : item.path);
      } else {
        setLSelected(item.path === lSelected ? undefined : item.path);
      }
    },
    onMouseEnter: () => {
      if (item.isDir) patchDrag({ overFolder: { side: item.side, path: item.path } });
    },
    onMouseLeave: () => {
      if (dragRef.current?.overFolder?.path === item.path && dragRef.current.overFolder.side === item.side) {
        patchDrag({ overFolder: null });
      }
    },
    className: cn(
      "group cursor-pointer select-none border-b border-border/50 hover:bg-hover",
      item.side === "remote" && rSelected === item.path && "bg-accent/10",
      item.side === "local" && lSelected === item.path && "bg-accent/10",
      folderHover && "bg-accent/15",
    ),
  });

  return (
    <div className="relative flex h-full flex-col bg-surface">
      {osDrag && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-accent/10 text-[12px] font-medium text-accent">
          Drop files to upload to {rPath}
        </div>
      )}

      {/* Floating drag preview */}
      {drag?.active && (
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-md border border-accent bg-elevated px-2.5 py-1.5 text-[12px] text-fg shadow-xl"
          style={{ left: drag.x + 14, top: drag.y + 12 }}
        >
          <FileIcon size={13} className="text-accent" />
          <span className="max-w-[220px] truncate font-mono">{drag.item.name}</span>
          <span className="text-[10px] text-subtle">
            {drag.item.side === "remote" ? "→ local" : "→ remote"}
          </span>
        </div>
      )}

      {/* Hint bar */}
      <div className="flex h-7 shrink-0 items-center justify-center gap-2 border-b border-border bg-bg/50 text-[11px] text-subtle">
        <ArrowLeftRight size={12} />
        Drag files across the panes to transfer — remote → local downloads, local → remote uploads
      </div>

      {/* Two panes */}
      <div className="flex min-h-0 flex-1">
        {/* ============ Remote pane (left) ============ */}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col border-r border-border",
            drag?.over === "remote" && drag.active && "bg-accent/5",
          )}
          onMouseEnter={() => patchDrag({ over: "remote" })}
          onMouseLeave={() => {
            const cur = dragRef.current;
            if (!cur) return;
            patchDrag({
              over: null,
              overFolder: cur.overFolder?.side === "remote" ? null : cur.overFolder,
            });
          }}
        >
          {/* Path bar */}
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
            <Button variant="ghost" size="sm" onClick={() => void loadRemote("/")} title="Root">
              <Home size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void loadRemote(parentPath(rPath))} title="Up">
              <ArrowUp size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void loadRemote(rPath)} title="Refresh">
              <RefreshCw size={14} />
            </Button>
            <span className="min-w-0 flex-1 select-text truncate px-1 font-mono text-[11px] text-muted">
              {rPath}
            </span>
            <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">remote</span>
          </div>

          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
            <Button
              variant={autoFollow ? "primary" : "secondary"}
              size="sm"
              onClick={() =>
                setAutoFollow((on) => {
                  const next = !on;
                  if (next && remoteCwd) void loadRemote(remoteCwd);
                  return next;
                })
              }
              title="Follow the terminal's current directory"
            >
              <LocateFixed size={13} />
              {autoFollow ? "Following" : "Follow"}
            </Button>
            <Button
              variant={rShowHidden ? "primary" : "secondary"}
              size="sm"
              onClick={() => setRShowHidden((v) => !v)}
              title={rShowHidden ? "Hide hidden files" : "Show hidden files"}
            >
              {rShowHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              Hidden
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void newRemoteFolder()}>
              <FolderPlus size={13} /> New
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void uploadHere()} title="Upload local files (or drop them anywhere)">
              <Upload size={13} /> Upload
            </Button>
            <div className="mx-1 h-4 w-px bg-border" />
            <Button
              variant="secondary"
              size="sm"
              disabled={!rSelected}
              title={rSelected ? `Explain ${rSelected}` : "Select a remote file first"}
              onClick={() => rSelected && void explainFile(sessionId, rSelected)}
            >
              <Sparkles size={13} /> Explain
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!rSelected}
              title={rSelected ? "Diff this file against another" : "Select a remote file first"}
              onClick={() => {
                if (!rSelected) return;
                const other = window.prompt("Diff against which file? Enter the full remote path:", rSelected);
                if (other && other.trim()) void diffFiles(sessionId, rSelected, other.trim());
              }}
            >
              <Sparkles size={13} /> Diff
            </Button>
          </div>

          {/* File list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rLoading && rFiles.length === 0 ? (
              <p className="p-4 text-[12px] text-subtle">Loading…</p>
            ) : rError ? (
              <p className="p-4 text-[12px] text-danger">{rError}</p>
            ) : (
              <table className="w-full text-[12px]">
                <tbody>
                  {rVisible.map((f) => {
                    const item: DragItem = { side: "remote", path: f.path, name: f.name, isDir: f.isDir };
                    const folderHover =
                      drag?.overFolder?.side === "remote" && drag.overFolder.path === f.path ? drag.overFolder : null;
                    return (
                      <tr
                        key={f.path}
                        {...rowDragProps(item, folderHover)}
                        onDoubleClick={() => (f.isDir ? void loadRemote(f.path) : startDownload(f.path, f.name, lPath))}
                      >
                        <td className="w-6 pl-2">
                          {f.isDir ? <Folder size={14} className="text-accent" /> : <FileIcon size={14} className="text-subtle" />}
                        </td>
                        <td className="max-w-[160px] truncate py-1.5 pr-2 font-mono text-fg">{f.name}</td>
                        <td className="px-2 text-right text-muted">{formatBytes(f.size)}</td>
                        <td className="hidden px-2 text-subtle sm:table-cell">{formatMtime(f.modified)}</td>
                        <td className="pr-2 text-right">
                          <span className="invisible flex justify-end gap-1 group-hover:visible">
                            {!f.isDir && (
                              <button
                                className="rounded p-1 text-muted hover:bg-bg hover:text-fg"
                                title="Download to local folder"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  startDownload(f.path, f.name, lPathRef.current);
                                }}
                              >
                                <Download size={13} />
                              </button>
                            )}
                            <button
                              className="rounded p-1 text-muted hover:bg-bg hover:text-fg"
                              title="Rename"
                              onClick={(e) => {
                                e.stopPropagation();
                                void doRenameRemote(f);
                              }}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              className="rounded p-1 text-muted hover:bg-bg hover:text-danger"
                              title="Delete"
                              onClick={(e) => {
                                e.stopPropagation();
                                void doDeleteRemote(f);
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                  {rVisible.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-4 text-center text-[12px] text-subtle">
                        Empty directory — drop local files here to upload
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* ============ Local pane (right) ============ */}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col",
            drag?.over === "local" && drag.active && "bg-accent/5",
          )}
          onMouseEnter={() => patchDrag({ over: "local" })}
          onMouseLeave={() => {
            const cur = dragRef.current;
            if (!cur) return;
            patchDrag({
              over: null,
              overFolder: cur.overFolder?.side === "local" ? null : cur.overFolder,
            });
          }}
        >
          {/* Path bar */}
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
            <Button variant="ghost" size="sm" onClick={() => void loadLocal(lPath)} title="Home">
              <Home size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void loadLocal(localParent(lPath))} title="Up">
              <ArrowUp size={14} />
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void loadLocal(lPath)} title="Refresh">
              <RefreshCw size={14} />
            </Button>
            <span className="min-w-0 flex-1 select-text truncate px-1 font-mono text-[11px] text-muted">
              {lPath || "loading…"}
            </span>
            <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] text-muted">local</span>
          </div>

          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
            <Button
              variant={lShowHidden ? "primary" : "secondary"}
              size="sm"
              onClick={() => setLShowHidden((v) => !v)}
              title={lShowHidden ? "Hide hidden files" : "Show hidden files"}
            >
              {lShowHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              Hidden
            </Button>
            <span className="text-[11px] text-subtle">Drop remote files here to download</span>
          </div>

          {/* File list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {lLoading && lFiles.length === 0 ? (
              <p className="p-4 text-[12px] text-subtle">Loading…</p>
            ) : lError ? (
              <p className="p-4 text-[12px] text-danger">{lError}</p>
            ) : (
              <table className="w-full text-[12px]">
                <tbody>
                  {lVisible.map((f) => {
                    const item: DragItem = { side: "local", path: f.path, name: f.name, isDir: f.isDir };
                    const folderHover =
                      drag?.overFolder?.side === "local" && drag.overFolder.path === f.path ? drag.overFolder : null;
                    return (
                      <tr
                        key={f.path}
                        {...rowDragProps(item, folderHover)}
                        onDoubleClick={() => f.isDir && void loadLocal(f.path)}
                      >
                        <td className="w-6 pl-2">
                          {f.isDir ? <Folder size={14} className="text-accent" /> : <FileIcon size={14} className="text-subtle" />}
                        </td>
                        <td className="max-w-[160px] truncate py-1.5 pr-2 font-mono text-fg">{f.name}</td>
                        <td className="px-2 text-right text-muted">{formatBytes(f.size)}</td>
                        <td className="hidden px-2 text-subtle sm:table-cell">{formatMtime(f.modified)}</td>
                        <td className="pr-2" />
                      </tr>
                    );
                  })}
                  {lVisible.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-4 text-center text-[12px] text-subtle">
                        Empty folder — drop remote files here to download
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Transfers */}
      {activeTransfers.length > 0 && (
        <div className="max-h-32 shrink-0 space-y-1.5 overflow-y-auto border-t border-border p-2">
          {activeTransfers.map((t) => {
            const pct = t.total > 0 ? (t.transferred / t.total) * 100 : t.done ? 100 : 0;
            return (
              <div key={t.transferId} className="text-[11px]">
                <div className="mb-0.5 flex justify-between text-muted">
                  <span className="truncate">{t.fileName}</span>
                  <span className="shrink-0 text-subtle">
                    {t.done ? (t.error ? "error" : "done") : `${Math.round(pct)}%`}
                  </span>
                </div>
                <Bar value={pct} tone={t.error ? "danger" : "accent"} />
                {t.error && <p className="mt-0.5 text-[10px] text-danger">{t.error}</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Windows-aware parent directory ("C:\\Users\\x" → "C:\\Users"). */
function localParent(p: string): string {
  const clean = p.replace(/[\\/]+$/, "");
  if (!clean) return p;
  const idx = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  if (idx <= 0) {
    // Drive root ("C:\", "C:/") or bare name — cannot go further up.
    return clean.length >= 2 && clean[1] === ":" ? `${clean.slice(0, 2)}\\` : clean;
  }
  return clean.slice(0, idx);
}

function joinLocal(dir: string, name: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + "/" + name;
}
