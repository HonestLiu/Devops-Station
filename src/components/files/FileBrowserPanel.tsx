import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { Event, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import {
  ArrowUp,
  Download,
  Eye,
  EyeOff,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderPlus,
  Home,
  LocateFixed,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Bar, Button, Input, SideIconButton } from "@/components/ui";
import { cn, formatBytes, formatMtime, formatPermissions, parentPath, textToBase64 } from "@/lib/utils";
import { localFs, pty, sftp, wsl, wslFs } from "@/lib/api";
import type { LocalEntry, RemoteFile, Tab, TransferProgress } from "@/lib/types";
import { useSessionStore } from "@/store/useSessionStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useContextMenu, type MenuItem } from "@/store/useContextMenu";

/**
 * A file-manager side panel shared by every terminal kind. The backend-specific
 * operations (SFTP / WSL / local disk) are injected via a [`FileAdapter`], so
 * the Local Shell, WSL and SSH tabs all render the same browsing experience:
 * path bar + follow-terminal + hidden files + new/rename/delete + (where the
 * backend supports it) upload/download with progress, drag-and-drop, "open in
 * default app" and "reveal in file manager".
 */

export interface FileAdapter {
  kind: "sftp" | "wsl" | "local";
  /** List a directory; entries are normalized to RemoteFile. */
  list(path: string): Promise<RemoteFile[]>;
  /** The initial directory (home / root) the panel opens at. */
  home(): Promise<string>;
  mkdir(path: string): Promise<void>;
  remove(path: string, isDir: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** When present the panel shows upload / download / drag-and-drop + progress. */
  transfer?: {
    upload(localPath: string, remoteDir: string, transferId: string): Promise<unknown>;
    download(remotePath: string, localPath: string, transferId: string): Promise<unknown>;
    onProgress(cb: (p: TransferProgress) => void): Promise<UnlistenFn>;
  };
  /** Open a file (double-click / row action): local → default app. */
  open?(file: RemoteFile): void;
  /** Reveal in the OS file manager (local only). */
  reveal?(file: RemoteFile): void;
  /** Fired when the user navigates into a directory (local: cd the terminal). */
  onNavigate?(path: string): void;
  /** Show the POSIX permission column (sftp/wsl yes, local no). */
  showPermissions?: boolean;
}

/** Adapter for an SSH (SFTP) session. */
export function createSftpAdapter(sessionId: string): FileAdapter {
  return {
    kind: "sftp",
    showPermissions: true,
    list: (p) => sftp.list(sessionId, p),
    home: async () => sftp.realpath(sessionId, ".").catch(() => "/"),
    mkdir: (p) => sftp.mkdir(sessionId, p),
    remove: (p, isDir) => sftp.remove(sessionId, p, isDir),
    rename: (from, to) => sftp.rename(sessionId, from, to),
    transfer: {
      upload: (localPath, remoteDir, id) => sftp.upload(sessionId, localPath, remoteDir, id),
      download: (remotePath, localPath, id) => sftp.download(sessionId, remotePath, localPath, id),
      onProgress: (cb) => sftp.onProgress(cb),
    },
  };
}

/** Adapter for a WSL distribution's filesystem (distro resolved lazily). */
export function createWslAdapter(initialDistro?: string): FileAdapter {
  let distro = initialDistro;
  const ensure = async (): Promise<string> => {
    if (distro) return distro;
    const list = await wsl.listDistros();
    const found = list.find((x) => x.isDefault) ?? list[0];
    if (!found) throw new Error("No WSL distribution found. Install one with `wsl --install`.");
    distro = found.name;
    return distro;
  };
  const bind =
    <A extends unknown[], R>(fn: (distro: string, ...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> =>
      fn(await ensure(), ...args);
  return {
    kind: "wsl",
    showPermissions: true,
    list: bind((d, p) => wslFs.list(d, p)),
    home: bind((d) => wslFs.home(d)),
    mkdir: bind((d, p) => wslFs.mkdir(d, p)),
    remove: bind((d, p, isDir) => wslFs.remove(d, p, isDir)),
    rename: bind((d, from, to) => wslFs.rename(d, from, to)),
    transfer: {
      upload: bind((d, lp, rd, id) => wslFs.upload(d, lp, rd, id)),
      download: bind((d, rp, lp, id) => wslFs.download(d, rp, lp, id)),
      onProgress: (cb) => wslFs.onProgress(cb),
    },
  };
}

/** Adapter for the local (host) filesystem, bound to a Local/WSL terminal tab. */
export function createLocalAdapter(tab: Tab): FileAdapter {
  const cdInto = (path: string) => {
    const quoted = `"${path.replace(/"/g, '\\"')}"`;
    if ((tab.kind === "local" || tab.kind === "wsl") && tab.sessionId) {
      void pty.write(tab.sessionId, textToBase64(`cd ${quoted}\r`));
    } else {
      void useTabsStore.getState().openLocal(path);
    }
  };
  const toRemote = (e: LocalEntry): RemoteFile => ({
    name: e.name,
    path: e.path,
    isDir: e.isDir,
    isSymlink: false,
    size: e.size,
    modified: e.modified,
    permissions: 0,
    owner: null,
    group: null,
  });
  return {
    kind: "local",
    showPermissions: false,
    list: async (p) => (await localFs.list(p)).map(toRemote),
    home: () => localFs.home(),
    mkdir: (p) => localFs.mkdir(p),
    remove: (p, isDir) => localFs.remove(p, isDir),
    rename: (from, to) => localFs.rename(from, to),
    open: (f) => void localFs.open(f.path),
    reveal: (f) => void localFs.reveal(f.path),
    onNavigate: (p) => cdInto(p),
  };
}

// --- panel ------------------------------------------------------------------

async function pickFiles(): Promise<string[] | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: true, title: "Select files to upload" });
    if (!picked) return null;
    return Array.isArray(picked) ? picked : [picked];
  } catch {
    alert("File pickers require the desktop app. Run with `npm run app:dev`.");
    return null;
  }
}

async function pickSave(name: string): Promise<string | null> {
  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return (await save({ title: "Save file as", defaultPath: name })) ?? null;
  } catch {
    alert("File pickers require the desktop app. Run with `npm run app:dev`.");
    return null;
  }
}

export function FileBrowserPanel({
  adapter,
  sessionId,
  onClose,
  title,
  chipIcon,
  onPreviewFile,
  aiActions,
  toolbarExtras,
}: {
  adapter: FileAdapter;
  /** Session id used to follow the terminal's cwd over OSC 7. */
  sessionId: string;
  onClose: () => void;
  title: string;
  chipIcon: ReactNode;
  /** Double-click a file → open this preview (SFTP). Preferred over adapter.open. */
  onPreviewFile?: (file: RemoteFile) => void;
  /** Extra context-menu items for a file (SFTP's AI actions). */
  aiActions?: (file: RemoteFile) => MenuItem[];
  /** Extra toolbar buttons rendered after the built-ins (SFTP's AI actions). */
  toolbarExtras?: ReactNode;
}) {
  const [path, setPath] = useState("");
  const [address, setAddress] = useState("");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [transfers, setTransfers] = useState<Record<string, TransferProgress>>({});
  const [selected, setSelected] = useState<string | undefined>();
  const [showHidden, setShowHidden] = useState(false);
  const [autoFollow, setAutoFollow] = useState(true);
  const remoteCwd = useSessionStore((s) => s.cwdBySession[sessionId]);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      setError(undefined);
      try {
        const list = await adapter.list(p);
        setFiles(list);
        setPath(p);
        setAddress(p);
        setSelected(undefined);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [adapter],
  );

  // Initial load: resolve home, then list it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const home = await adapter.home().catch(() => "");
        if (cancelled) return;
        const list = await adapter.list(home).catch(() => [] as RemoteFile[]);
        if (cancelled) return;
        setFiles(list);
        setPath(home);
        setAddress(home);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  // Follow the terminal: navigate to its cwd when it changes (unless paused).
  useEffect(() => {
    if (autoFollow && remoteCwd && remoteCwd !== pathRef.current) {
      void load(remoteCwd);
    }
  }, [remoteCwd, autoFollow, load]);

  // Transfer progress → reload the listing when a transfer finishes.
  useEffect(() => {
    if (!adapter.transfer) return;
    const un: Promise<UnlistenFn> = adapter.transfer.onProgress((p) => {
      setTransfers((prev) => ({ ...prev, [p.transferId]: p }));
      if (p.done) {
        const tid = p.transferId;
        window.setTimeout(() => {
          setTransfers((prev) => {
            const next = { ...prev };
            delete next[tid];
            return next;
          });
          void load(pathRef.current);
        }, 500);
      }
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, [adapter, load]);

  // Drag-and-drop upload (window-level Tauri event while the panel is mounted).
  useEffect(() => {
    if (!adapter.transfer) return;
    let un: UnlistenFn | undefined;
    let cancelled = false;
    const p = getCurrentWebview().onDragDropEvent((event: Event<DragDropEvent>) => {
      const e = event.payload;
      if (e.type === "drop") {
        setDragActive(false);
        for (const localPath of e.paths) {
          void uploadPath(localPath);
        }
      } else if (e.type === "leave") {
        setDragActive(false);
      } else {
        setDragActive(true);
      }
    });
    p.then((fn) => {
      if (cancelled) fn();
      else un = fn;
    });
    return () => {
      cancelled = true;
      un?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adapter]);

  const uploadPath = useCallback(
    async (localPath: string) => {
      if (!adapter.transfer) return;
      const id = crypto.randomUUID();
      const name = localPath.split(/[\\/]/).pop() ?? "file";
      setTransfers((prev) => ({
        ...prev,
        [id]: { transferId: id, fileName: name, transferred: 0, total: 0, done: false },
      }));
      try {
        await adapter.transfer.upload(localPath, path, id);
      } catch (e) {
        setTransfers((prev) => ({
          ...prev,
          [id]: {
            transferId: id,
            fileName: name,
            transferred: 0,
            total: 0,
            done: true,
            error: (e as Error).message,
          },
        }));
      }
    },
    [adapter, path],
  );

  const uploadHere = async () => {
    const paths = await pickFiles();
    if (!paths) return;
    for (const localPath of paths) {
      void uploadPath(localPath);
    }
  };

  // Manual navigation pauses auto-follow so the panel doesn't yank back to the
  // terminal directory on the next prompt; the user re-enables it via the toggle.
  const navigate = useCallback(
    (p: string) => {
      setAutoFollow(false);
      void load(p);
      adapter.onNavigate?.(p);
    },
    [adapter, load],
  );

  const toggleFollow = useCallback(() => {
    setAutoFollow((on) => {
      const next = !on;
      if (next && remoteCwd) void load(remoteCwd);
      return next;
    });
  }, [remoteCwd, load]);

  const download = async (file: RemoteFile) => {
    if (!adapter.transfer) return;
    const target = await pickSave(file.name);
    if (!target) return;
    const id = crypto.randomUUID();
    setTransfers((prev) => ({
      ...prev,
      [id]: { transferId: id, fileName: file.name, transferred: 0, total: file.size, done: false },
    }));
    try {
      await adapter.transfer.download(file.path, target, id);
    } catch (e) {
      setTransfers((prev) => ({
        ...prev,
        [id]: {
          transferId: id,
          fileName: file.name,
          transferred: 0,
          total: file.size,
          done: true,
          error: (e as Error).message,
        },
      }));
    }
  };

  const doRename = async (file: RemoteFile) => {
    const next = window.prompt("Rename to", file.name);
    if (!next || next === file.name) return;
    const to = `${path === "/" ? "" : path}/${next}`;
    try {
      await adapter.rename(file.path, to);
      void load(path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doDelete = async (file: RemoteFile) => {
    if (!window.confirm(`Delete ${file.isDir ? "folder" : "file"} "${file.name}"?`)) return;
    try {
      await adapter.remove(file.path, file.isDir);
      void load(path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const newFolder = async () => {
    const name = window.prompt("New folder name");
    if (!name) return;
    try {
      await adapter.mkdir(`${path === "/" ? "" : path}/${name}`);
      void load(path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const showCtx = useContextMenu((s) => s.show);
  const closeCtx = useContextMenu((s) => s.close);

  const onFileContextMenu = (e: ReactMouseEvent, f: RemoteFile) => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      ...(adapter.transfer && !f.isDir
        ? [
            {
              id: "download",
              label: "下载",
              icon: <Download size={14} />,
              onClick: () => {
                closeCtx();
                void download(f);
              },
            } as MenuItem,
          ]
        : []),
      ...(adapter.open && !f.isDir
        ? [
            {
              id: "open",
              label: "打开",
              icon: <ExternalLink size={14} />,
              onClick: () => {
                closeCtx();
                adapter.open?.(f);
              },
            } as MenuItem,
          ]
        : []),
      ...(adapter.reveal
        ? [
            {
              id: "reveal",
              label: "在文件管理器中显示",
              icon: <Folder size={14} />,
              onClick: () => {
                closeCtx();
                adapter.reveal?.(f);
              },
            } as MenuItem,
          ]
        : []),
      ...(aiActions?.(f) ?? []).map((item) => ({
        ...item,
        onClick: () => {
          closeCtx();
          item.onClick?.();
        },
      })),
      {
        id: "rename",
        label: "重命名",
        icon: <Pencil size={14} />,
        onClick: () => {
          closeCtx();
          void doRename(f);
        },
      },
      {
        id: "delete",
        label: "删除",
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => {
          closeCtx();
          void doDelete(f);
        },
      },
      { id: "sep", separator: true, label: "" },
      ...(adapter.transfer
        ? [
            {
              id: "upload",
              label: "上传到此处",
              icon: <Upload size={14} />,
              onClick: () => {
                closeCtx();
                void uploadHere();
              },
            } as MenuItem,
          ]
        : []),
      {
        id: "new-folder",
        label: "新建文件夹",
        icon: <FolderPlus size={14} />,
        onClick: () => {
          closeCtx();
          void newFolder();
        },
      },
      {
        id: "refresh",
        label: "刷新",
        icon: <RefreshCw size={14} />,
        onClick: () => {
          closeCtx();
          void load(path);
        },
      },
    ];
    showCtx(e.clientX, e.clientY, items);
  };

  const [dragActive, setDragActive] = useState(false);

  const activeTransfers = Object.values(transfers);
  const visible = showHidden ? files : files.filter((f) => !f.name.startsWith("."));

  const homeDir = async () => {
    const h = await adapter.home().catch(() => "");
    if (h) navigate(h);
  };

  const openRow = (f: RemoteFile) => {
    if (f.isDir) {
      navigate(f.path);
      return;
    }
    if (onPreviewFile) {
      onPreviewFile(f);
    } else if (adapter.open) {
      adapter.open(f);
    } else if (adapter.transfer) {
      void download(f);
    }
  };

  return (
    <div
      className={cn(
        "relative flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface",
        dragActive && "ring-2 ring-accent",
      )}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-accent/10 text-[12px] font-medium text-accent">
          Drop files to upload to {path}
        </div>
      )}

      {/* Header — same shape as the Files / USB / AI side panels */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <span className="icon-chip h-6 w-6 shrink-0">{chipIcon}</span>
        <span className="flex-1 truncate text-[12px] font-semibold text-fg">{title}</span>
        <SideIconButton
          label={
            autoFollow
              ? "Following the terminal's directory — click to pause"
              : "Paused — click to follow the terminal's directory"
          }
          onClick={toggleFollow}
          active={autoFollow}
          icon={<LocateFixed size={14} />}
        />
        <SideIconButton label="Refresh" onClick={() => void load(path)} icon={<RefreshCw size={14} />} />
        <SideIconButton label="Close" onClick={onClose} icon={<X size={14} />} />
      </div>

      {/* Path bar */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <SideIconButton label="Home" onClick={() => void homeDir()} icon={<Home size={14} />} />
        <SideIconButton
          label="Up"
          onClick={() => navigate(parentPath(path) || path)}
          icon={<ArrowUp size={14} />}
        />
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") navigate(address.trim() || path);
          }}
          spellCheck={false}
          placeholder="path…"
          className="h-7 flex-1 px-2 font-mono text-[11px]"
        />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button variant={autoFollow ? "primary" : "secondary"} size="sm" onClick={toggleFollow} title="Follow the terminal's current directory">
          <LocateFixed size={13} />
          {autoFollow ? "Following" : "Follow"}
        </Button>
        <Button
          variant={showHidden ? "primary" : "secondary"}
          size="sm"
          onClick={() => setShowHidden((v) => !v)}
          title={showHidden ? "Hide hidden files" : "Show hidden files"}
        >
          {showHidden ? <EyeOff size={13} /> : <Eye size={13} />}
          Hidden
        </Button>
        <Button variant="secondary" size="sm" onClick={newFolder}>
          <FolderPlus size={13} /> New
        </Button>
        {adapter.transfer && (
          <Button variant="secondary" size="sm" onClick={uploadHere} title="Upload files (or drop them onto the panel)">
            <Upload size={13} /> Upload
          </Button>
        )}
        {toolbarExtras}
      </div>

      {/* File list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading && files.length === 0 ? (
          <p className="p-4 text-[12px] text-subtle">Loading…</p>
        ) : error ? (
          <p className="p-4 text-[12px] text-danger">{error}</p>
        ) : (
          <table className="w-full text-[12px]">
            <tbody>
              {visible.map((f) => (
                <tr
                  key={f.path}
                  onClick={() => setSelected(f.path === selected ? undefined : f.path)}
                  onDoubleClick={() => openRow(f)}
                  onContextMenu={(e) => onFileContextMenu(e, f)}
                  className={cn(
                    "group cursor-pointer border-b border-border/50 hover:bg-hover",
                    selected === f.path && "bg-accent/10",
                  )}
                >
                  <td className="w-6 pl-2">
                    {f.isDir ? (
                      <Folder size={14} className="text-accent" />
                    ) : (
                      <FileIcon size={14} className="text-subtle" />
                    )}
                  </td>
                  <td className="max-w-[120px] truncate py-1.5 pr-2 font-mono text-fg">{f.name}</td>
                  <td className="px-2 text-right text-muted">{formatBytes(f.size)}</td>
                  {adapter.showPermissions && (
                    <td className="hidden px-2 text-subtle sm:table-cell">
                      {formatPermissions(f.permissions, f.isDir)}
                    </td>
                  )}
                  <td className="hidden px-2 text-subtle md:table-cell">{formatMtime(f.modified)}</td>
                  <td className="pr-2 text-right">
                    <span className="invisible flex justify-end gap-1 group-hover:visible">
                      {onPreviewFile && !f.isDir && (
                        <button
                          className="rounded p-1 text-muted hover:bg-bg hover:text-fg"
                          title="预览"
                          onClick={(e) => {
                            e.stopPropagation();
                            onPreviewFile(f);
                          }}
                        >
                          <Eye size={13} />
                        </button>
                      )}
                      {adapter.open && !f.isDir && (
                        <button
                          className="rounded p-1 text-muted hover:bg-bg hover:text-fg"
                          title="Open in default app"
                          onClick={(e) => {
                            e.stopPropagation();
                            adapter.open?.(f);
                          }}
                        >
                          <ExternalLink size={13} />
                        </button>
                      )}
                      {adapter.transfer && !f.isDir && (
                        <button
                          className="rounded p-1 text-muted hover:bg-bg hover:text-fg"
                          title="Download"
                          onClick={(e) => {
                            e.stopPropagation();
                            void download(f);
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
                          void doRename(f);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="rounded p-1 text-muted hover:bg-bg hover:text-danger"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          void doDelete(f);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-[12px] text-subtle">
                    Empty directory
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
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
