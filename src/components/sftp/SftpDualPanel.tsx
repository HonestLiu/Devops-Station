import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  AlertCircle,
  ArrowLeftRight,
  ArrowUp,
  Check,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FilePen,
  Folder,
  FolderPlus,
  HardDrive,
  Home,
  KeyRound,
  Loader2,
  LocateFixed,
  Pencil,
  RefreshCw,
  RotateCw,
  Server,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";

import { sftp } from "@/lib/api";
import { localFs } from "@/lib/api";
import { Bar, Badge, Button, Dialog, Input, SideIconButton } from "@/components/ui";
import { RemoteFileEditor } from "./RemoteFileEditor";
import { RemoteFilePreview } from "./RemoteFilePreview";
import { PermsDialog } from "./PermsDialog";
import { cn, formatBytes, formatMtime, parentPath } from "@/lib/utils";
import { explainFile, diffFiles } from "@/ai/tasks";
import { useSessionStore } from "@/store/useSessionStore";
import { useT } from "@/i18n";
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
  active: boolean;
  over: "remote" | "local" | null;
  overFolder: { side: "remote" | "local"; path: string } | null;
}

/**
 * Dual-pane SFTP file manager (remote host ⇄ local machine) with a modern,
 * card-based UI. Drag & drop is mouse-driven (WebView2-safe, no HTML5 DnD):
 * mousedown → move past threshold → floating preview → mouseup commits.
 */
export function SftpDualPanel({ sessionId }: { sessionId: string }) {
  const t = useT();

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

  // --- Inline remote-file editor + permission dialog ---
  const [editing, setEditing] = useState<{ path: string; name: string } | null>(null);
  const [permTarget, setPermTarget] = useState<RemoteFile | null>(null);

  // --- Styled dialogs replacing native window.prompt / window.confirm ---
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<RemoteFile | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<RemoteFile | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffPath, setDiffPath] = useState("");

  // --- Remote-file preview (images, PDF, video, audio, Markdown, text) ---
  const [preview, setPreview] = useState<{ path: string; name: string } | null>(null);

  // Remembers the source/target of each transfer so a failed one can be resumed
  // from the last acknowledged byte offset.
  const transferMeta = useRef<
    Record<
      string,
      { kind: "up" | "down"; localPath: string; remotePath?: string; remoteDir?: string }
    >
  >({});

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
        // Keep failed rows so the user can hit "Resume" — only clean up on success.
        if (p.error) return;
        window.setTimeout(() => {
          setTransfers((prev) => {
            const next = { ...prev };
            delete next[tid];
            delete transferSide.current[tid];
            delete transferMeta.current[tid];
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
  const startUpload = (localPath: string, remoteDir: string, offset?: number) => {
    const id = crypto.randomUUID();
    const name = localPath.split(/[\\/]/).pop() ?? "file";
    transferSide.current[id] = "remote";
    transferMeta.current[id] = { kind: "up", localPath, remoteDir };
    setTransfers((prev) => ({
      ...prev,
      [id]: {
        transferId: id,
        fileName: name,
        transferred: offset ?? 0,
        total: 0,
        done: false,
      },
    }));
    void sftp
      .upload(sessionId, localPath, remoteDir, id, offset)
      .catch((e) => {
        setTransfers((prev) => ({
          ...prev,
          [id]: { ...prev[id], done: true, error: (e as Error).message },
        }));
      });
  };

  const startDownload = (remotePath: string, name: string, localDir: string, offset?: number) => {
    const id = crypto.randomUUID();
    transferSide.current[id] = "local";
    transferMeta.current[id] = { kind: "down", remotePath, localPath: joinLocal(localDir, name) };
    setTransfers((prev) => ({
      ...prev,
      [id]: {
        transferId: id,
        fileName: name,
        transferred: offset ?? 0,
        total: 0,
        done: false,
      },
    }));
    void sftp
      .download(sessionId, remotePath, joinLocal(localDir, name), id, offset)
      .catch((e) => {
        setTransfers((prev) => ({
          ...prev,
          [id]: { ...prev[id], done: true, error: (e as Error).message },
        }));
      });
  };

  // Resume a failed transfer from the last acknowledged byte offset. Reuses the
  // same transfer id so the existing row updates in place.
  const resumeTransfer = (t: TransferProgress) => {
    const meta = transferMeta.current[t.transferId];
    if (!meta) return;
    const offset = t.transferred;
    const tid = t.transferId;
    setTransfers((prev) => ({
      ...prev,
      [tid]: { ...prev[tid], done: false, error: null },
    }));
    const fail = (e: unknown) =>
      setTransfers((prev) => ({
        ...prev,
        [tid]: { ...prev[tid], done: true, error: (e as Error).message },
      }));
    if (meta.kind === "up") {
      void sftp.upload(sessionId, meta.localPath, meta.remoteDir!, tid, offset).catch(fail);
    } else {
      void sftp.download(sessionId, meta.remotePath!, meta.localPath!, tid, offset).catch(fail);
    }
  };

  // --- Custom mouse drag & drop (WebView2-safe) ---
  const patchDrag = (patch: Partial<DragState>) => {
    if (!dragRef.current) return;
    const next = { ...dragRef.current, ...patch };
    dragRef.current = next;
    setDrag(next);
  };

  const commitDrop = (d: DragState): boolean => {
    const target = d.overFolder
      ? d.overFolder
      : d.over
        ? { side: d.over, path: d.over === "remote" ? rPathRef.current : lPathRef.current }
        : null;
    if (!target) return false;
    if (d.item.side === target.side) return false; // same side — nothing to transfer
    if (target.side === "remote") startUpload(d.item.path, target.path);
    else startDownload(d.item.path, d.item.name, target.path);
    return true;
  };

  // Movement (px) before a press becomes a drag. Small enough for a comfortable
  // drag, large enough that a plain click with a shaky hand still selects.
  const DRAG_THRESHOLD = 10;

  const startRowDrag = (e: ReactMouseEvent, item: DragItem) => {
    if (e.button !== 0 || item.isDir) return;
    if ((e.target as HTMLElement).closest("button")) return;

    const sx = e.clientX;
    const sy = e.clientY;
    dragRef.current = { item, x: sx, y: sy, active: false, over: null, overFolder: null };
    setDrag(dragRef.current);
    let moved = false;

    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD) return;
      if (!moved) {
        moved = true;
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
      if (moved && d) {
        // Only swallow the click that follows a *real* transfer drop, so a
        // plain click (no drag) always selects normally.
        suppressClick.current = commitDrop(d);
      } else {
        suppressClick.current = false;
      }
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

  const submitNewFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderOpen(false);
    setNewFolderName("");
    try {
      await sftp.mkdir(sessionId, `${rPath === "/" ? "" : rPath}/${name}`);
      void loadRemote(rPath);
    } catch (e) {
      setRError((e as Error).message);
    }
  };

  const submitRename = async () => {
    const next = renameName.trim();
    if (!renameTarget || !next || next === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    const to = `${rPath === "/" ? "" : rPath}/${next}`;
    setRenameTarget(null);
    try {
      await sftp.rename(sessionId, renameTarget.path, to);
      void loadRemote(rPath);
    } catch (e) {
      setRError((e as Error).message);
    }
  };

  const submitDelete = async () => {
    const f = deleteTarget;
    setDeleteTarget(null);
    if (!f) return;
    try {
      await sftp.remove(sessionId, f.path, f.isDir);
      void loadRemote(rPath);
    } catch (e) {
      setRError((e as Error).message);
    }
  };

  const submitDiff = () => {
    const other = diffPath.trim();
    setDiffOpen(false);
    if (!rSelected || !other) return;
    void diffFiles(sessionId, rSelected, other);
  };

  const rVisible = rShowHidden ? rFiles : rFiles.filter((f) => !f.name.startsWith("."));
  const lVisible = lShowHidden ? lFiles : lFiles.filter((f) => !f.name.startsWith("."));
  const activeTransfers = Object.values(transfers);

  // Shared row props for a pane's file rows.
  const rowDragProps = (
    item: DragItem,
    selected: boolean,
    folderHover: boolean,
  ) => ({
    onMouseDown: (e: ReactMouseEvent) => startRowDrag(e, item),
    onClick: () => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      if (item.side === "remote") setRSelected(item.path === rSelected ? undefined : item.path);
      else setLSelected(item.path === lSelected ? undefined : item.path);
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
      "group flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors hover:bg-hover",
      selected && "bg-accent/10 hover:bg-accent/15",
      folderHover && "bg-accent/15 ring-1 ring-inset ring-accent/40",
    ),
  });

  const RowAction = ({
    icon,
    label,
    tone,
    onClick,
  }: {
    icon: React.ReactNode;
    label: string;
    tone?: "default" | "danger";
    onClick: () => void;
  }) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-fg",
        tone === "danger" && "hover:!bg-danger/10 hover:!text-danger",
      )}
    >
      {icon}
    </button>
  );

  return (
    <div className="relative flex h-full flex-col gap-2 bg-bg p-2">
      {osDrag && (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-lg border border-dashed border-accent/50 bg-accent/10 text-[12px] font-medium text-accent backdrop-blur-[1px]">
          Drop files to upload to {rPath}
        </div>
      )}

      {/* Floating drag preview */}
      {drag?.active && (
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2 text-[12px] text-fg shadow-2xl"
          style={{ left: drag.x + 14, top: drag.y + 12 }}
        >
          <FileIcon size={14} className="text-accent" />
          <span className="max-w-[220px] truncate font-mono">{drag.item.name}</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-semibold",
              drag.item.side === "remote" ? "bg-accent/15 text-accent" : "bg-hover text-muted",
            )}
          >
            {drag.item.side === "remote" ? "→ local" : "→ remote"}
          </span>
        </div>
      )}

      {/* Hint strip */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-surface px-2.5 text-[11px] text-subtle">
        <ArrowLeftRight size={13} className="text-accent" />
        <span>
          <span className="font-medium text-accent">Remote</span> ⇄{" "}
          <span className="font-medium text-muted">Local</span> — drag files across to transfer
        </span>
      </div>

      {/* Two panes */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* ============ Remote pane (left) ============ */}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-surface transition-shadow",
            drag?.over === "remote" && drag.active && "border-accent/50 ring-2 ring-accent/30",
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
          {/* Pane header: icon chip + nav + path + badge */}
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
            <span className="icon-chip h-6 w-6 shrink-0">
              <Server size={13} className="text-accent" />
            </span>
            <SideIconButton label="Root" onClick={() => void loadRemote("/")} icon={<Home size={14} />} />
            <SideIconButton
              label="Up"
              onClick={() => void loadRemote(parentPath(rPath))}
              icon={<ArrowUp size={14} />}
            />
            <SideIconButton label="Refresh" onClick={() => void loadRemote(rPath)} icon={<RefreshCw size={14} />} />
            <Input
              value={rPath}
              readOnly
              spellCheck={false}
              className="h-7 flex-1 px-2 font-mono text-[11px]"
            />
            <Badge tone="accent">REMOTE</Badge>
          </div>

          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5">
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
            <Button variant="secondary" size="sm" onClick={() => setNewFolderOpen(true)} title="New folder">
              <FolderPlus size={13} /> New
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void uploadHere()} title="Upload local files (or drop them anywhere)">
              <Upload size={13} /> Upload
            </Button>
            <div className="mx-0.5 h-4 w-px bg-border/70" />
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
                setDiffPath(rSelected);
                setDiffOpen(true);
              }}
            >
              <Sparkles size={13} /> Diff
            </Button>
          </div>

          {/* File list */}
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {rLoading && rFiles.length === 0 ? (
              <div className="flex h-full items-center justify-center gap-2 text-[12px] text-subtle">
                <Loader2 size={14} className="animate-spin text-accent" /> Loading…
              </div>
            ) : rError ? (
              <div className="flex h-full items-center justify-center gap-2 px-4 text-[12px] text-danger">
                <AlertCircle size={14} /> {rError}
              </div>
            ) : (
              <div className="space-y-0.5">
                {rVisible.map((f) => {
                  const item: DragItem = { side: "remote", path: f.path, name: f.name, isDir: f.isDir };
                  const selected = rSelected === f.path;
                  const folderHover = drag?.overFolder?.side === "remote" && drag.overFolder.path === f.path;
                  return (
                    <div
                      key={f.path}
                      {...rowDragProps(item, selected, !!folderHover)}
                      onDoubleClick={() =>
                        f.isDir
                          ? void loadRemote(f.path)
                          : setPreview({ path: f.path, name: f.name })
                      }
                      title={
                        f.isDir
                          ? "Double-click to open"
                          : "Double-click to edit · drag to the right side to download"
                      }
                    >
                      {f.isDir ? (
                        <Folder size={15} className="shrink-0 text-accent" />
                      ) : (
                        <FileIcon size={15} className="shrink-0 text-subtle" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-fg">{f.name}</span>
                      <span className="shrink-0 w-14 text-right text-[11px] text-muted">{formatBytes(f.size)}</span>
                      <span className="hidden w-24 shrink-0 text-right text-[11px] text-subtle sm:block">
                        {formatMtime(f.modified)}
                      </span>
                      <span className="invisible flex shrink-0 items-center gap-0.5 group-hover:visible">
                        {!f.isDir && (
                          <RowAction
                            icon={<Eye size={13} />}
                            label={t("sftp.preview")}
                            onClick={() => setPreview({ path: f.path, name: f.name })}
                          />
                        )}
                        {!f.isDir && (
                          <RowAction
                            icon={<Download size={13} />}
                            label="Download to local folder"
                            onClick={() => startDownload(f.path, f.name, lPathRef.current)}
                          />
                        )}
                        <RowAction
                          icon={<FilePen size={13} />}
                          label="Edit file"
                          onClick={() => setEditing({ path: f.path, name: f.name })}
                        />
                        <RowAction
                          icon={<KeyRound size={13} />}
                          label="Permissions (chmod / chown)"
                          onClick={() => setPermTarget(f)}
                        />
                        <RowAction
                          icon={<Pencil size={13} />}
                          label="Rename"
                          onClick={() => {
                            setRenameName(f.name);
                            setRenameTarget(f);
                          }}
                        />
                        <RowAction
                          icon={<Trash2 size={13} />}
                          label="Delete"
                          tone="danger"
                          onClick={() => setDeleteTarget(f)}
                        />
                      </span>
                    </div>
                  );
                })}
                {rVisible.length === 0 && (
                  <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-[12px] text-subtle">
                    <Folder size={22} className="text-border" />
                    Empty directory — drop local files here to upload
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ============ Local pane (right) ============ */}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-surface transition-shadow",
            drag?.over === "local" && drag.active && "border-accent/50 ring-2 ring-accent/30",
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
          {/* Pane header: icon chip + nav + path + badge */}
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
            <span className="icon-chip h-6 w-6 shrink-0">
              <HardDrive size={13} className="text-muted" />
            </span>
            <SideIconButton label="Home" onClick={() => void loadLocal(lPath)} icon={<Home size={14} />} />
            <SideIconButton
              label="Up"
              onClick={() => void loadLocal(localParent(lPath))}
              icon={<ArrowUp size={14} />}
            />
            <SideIconButton label="Refresh" onClick={() => void loadLocal(lPath)} icon={<RefreshCw size={14} />} />
            <Input
              value={lPath || "loading…"}
              readOnly
              spellCheck={false}
              className="h-7 flex-1 px-2 font-mono text-[11px]"
            />
            <Badge tone="neutral">LOCAL</Badge>
          </div>

          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5">
            <Button
              variant={lShowHidden ? "primary" : "secondary"}
              size="sm"
              onClick={() => setLShowHidden((v) => !v)}
              title={lShowHidden ? "Hide hidden files" : "Show hidden files"}
            >
              {lShowHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              Hidden
            </Button>
            <span className="ml-auto text-[11px] text-subtle">Drop remote files here to download</span>
          </div>

          {/* File list */}
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {lLoading && lFiles.length === 0 ? (
              <div className="flex h-full items-center justify-center gap-2 text-[12px] text-subtle">
                <Loader2 size={14} className="animate-spin text-accent" /> Loading…
              </div>
            ) : lError ? (
              <div className="flex h-full items-center justify-center gap-2 px-4 text-[12px] text-danger">
                <AlertCircle size={14} /> {lError}
              </div>
            ) : (
              <div className="space-y-0.5">
                {lVisible.map((f) => {
                  const item: DragItem = { side: "local", path: f.path, name: f.name, isDir: f.isDir };
                  const selected = lSelected === f.path;
                  const folderHover = drag?.overFolder?.side === "local" && drag.overFolder.path === f.path;
                  return (
                    <div
                      key={f.path}
                      {...rowDragProps(item, selected, !!folderHover)}
                      onDoubleClick={() => f.isDir && void loadLocal(f.path)}
                      title={f.isDir ? "Double-click to open" : "Drag to the left side to upload"}
                    >
                      {f.isDir ? (
                        <Folder size={15} className="shrink-0 text-accent" />
                      ) : (
                        <FileIcon size={15} className="shrink-0 text-subtle" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-fg">{f.name}</span>
                      <span className="shrink-0 w-14 text-right text-[11px] text-muted">{formatBytes(f.size)}</span>
                      <span className="hidden w-24 shrink-0 text-right text-[11px] text-subtle sm:block">
                        {formatMtime(f.modified)}
                      </span>
                      <span className="w-7 shrink-0" />
                    </div>
                  );
                })}
                {lVisible.length === 0 && (
                  <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-[12px] text-subtle">
                    <HardDrive size={22} className="text-border" />
                    Empty folder — drop remote files here to download
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Transfers */}
      {activeTransfers.length > 0 && (
        <div className="max-h-36 shrink-0 space-y-1.5 overflow-y-auto rounded-lg border border-border/60 bg-surface px-3 py-2">
          {activeTransfers.map((t) => {
            const pct = t.total > 0 ? (t.transferred / t.total) * 100 : t.done ? 100 : 0;
            return (
              <div key={t.transferId} className="flex items-center gap-2 text-[11px]">
                {t.done ? (
                  t.error ? (
                    <AlertCircle size={13} className="shrink-0 text-danger" />
                  ) : (
                    <Check size={13} className="shrink-0 text-success" />
                  )
                ) : (
                  <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
                )}
                <span className="min-w-0 flex-1 truncate text-muted">{t.fileName}</span>
                <span className="w-10 shrink-0 text-right text-subtle">
                  {t.done ? (t.error ? "error" : "done") : `${Math.round(pct)}%`}
                </span>
                <div className="w-24 shrink-0">
                  <Bar value={pct} tone={t.error ? "danger" : "accent"} />
                </div>
                {t.error ? (
                  <>
                    <span className="max-w-[200px] truncate text-[10px] text-danger" title={t.error}>
                      {t.error}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-1.5"
                      onClick={() => resumeTransfer(t)}
                      title="Resume from the last transferred byte"
                    >
                      <RotateCw size={12} /> Resume
                    </Button>
                  </>
                ) : (
                  t.done && <Check size={13} className="shrink-0 text-success" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Inline remote-file editor */}
      {editing && (
        <RemoteFileEditor
          sessionId={sessionId}
          path={editing.path}
          name={editing.name}
          onClose={() => setEditing(null)}
          onSaved={() => void loadRemote(rPathRef.current)}
          onDownload={(p, n) => startDownload(p, n, lPathRef.current)}
        />
      )}

      {/* Remote-file preview (images, PDF, video, audio, Markdown, text) */}
      {preview && (
        <RemoteFilePreview
          sessionId={sessionId}
          path={preview.path}
          name={preview.name}
          onClose={() => setPreview(null)}
          onEdit={(p, n) => setEditing({ path: p, name: n })}
          onDownload={(p, n) => startDownload(p, n, lPathRef.current)}
        />
      )}

      {/* Permission editor (chmod / chown) */}
      {permTarget && (
        <PermsDialog
          sessionId={sessionId}
          file={permTarget}
          onClose={() => setPermTarget(null)}
          onApplied={() => void loadRemote(rPathRef.current)}
        />
      )}

      {/* New folder */}
      <Dialog
        open={newFolderOpen}
        onClose={() => {
          setNewFolderOpen(false);
          setNewFolderName("");
        }}
        title="New folder"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => {
              setNewFolderOpen(false);
              setNewFolderName("");
            }}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void submitNewFolder()}>
              {t("common.confirm")}
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={newFolderName}
          placeholder="folder name"
          onChange={(e) => setNewFolderName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitNewFolder();
          }}
        />
      </Dialog>

      {/* Rename */}
      <Dialog
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        title="Rename"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setRenameTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => void submitRename()}>
              {t("common.confirm")}
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={renameName}
          onChange={(e) => setRenameName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitRename();
          }}
        />
      </Dialog>

      {/* Delete confirm */}
      <Dialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete"
        description={
          deleteTarget
            ? `Delete ${deleteTarget.isDir ? "folder" : "file"} "${deleteTarget.name}"? This cannot be undone.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" size="sm" onClick={() => void submitDelete()}>
              {t("common.confirm")}
            </Button>
          </>
        }
      >
        <span />
      </Dialog>

      {/* Diff against another file */}
      <Dialog
        open={diffOpen}
        onClose={() => setDiffOpen(false)}
        title="Diff against file"
        description="Enter the full remote path of the other file."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDiffOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={() => submitDiff()}>
              {t("common.confirm")}
            </Button>
          </>
        }
      >
        <Input
          autoFocus
          value={diffPath}
          placeholder="/remote/path/to/file"
          onChange={(e) => setDiffPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitDiff();
          }}
        />
      </Dialog>
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
