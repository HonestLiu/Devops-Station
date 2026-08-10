import { useCallback, useEffect, useRef, useState } from "react";
import type { Event, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import {
  ArrowUp,
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
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { wsl, wslFs } from "@/lib/api";
import { Bar, Button } from "@/components/ui";
import {
  cn,
  formatBytes,
  formatMtime,
  formatPermissions,
  parentPath,
} from "@/lib/utils";
import type { RemoteFile, TransferProgress } from "@/lib/types";
import { useSessionStore } from "@/store/useSessionStore";

// `open`/`save` resolve to real local filesystem paths inside Tauri. In a bare
// browser preview they reject, which we catch and surface as a hint.
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

export function WslPanel({
  sessionId,
  distro: initialDistro,
  onClose,
}: {
  sessionId: string;
  /** Distro name; when omitted we resolve the default distro on mount. */
  distro?: string;
  onClose: () => void;
}) {
  const [distro, setDistro] = useState<string | undefined>(initialDistro);

  // Resolve the default distro when the panel was opened without an explicit one.
  // On any failure we surface a message instead of hanging on "Resolving distro…".
  useEffect(() => {
    if (initialDistro) return;
    let cancelled = false;
    wsl
      .listDistros()
      .then((list) => {
        if (cancelled) return;
        const d = list.find((x) => x.isDefault) ?? list[0];
        if (d) {
          setDistro(d.name);
        } else {
          setError("No WSL distribution found. Install one with `wsl --install`.");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError("Could not list WSL distros: " + ((e as Error)?.message ?? String(e)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialDistro]);

  const [path, setPath] = useState("/");
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [transfers, setTransfers] = useState<Record<string, TransferProgress>>({});
  const [selected, setSelected] = useState<string | undefined>();
  const [showHidden, setShowHidden] = useState(false);

  // Auto-follow: when on, the panel tracks the terminal's working directory
  // (reported over OSC 7 by the shell). Manual navigation pauses following.
  const [autoFollow, setAutoFollow] = useState(true);
  const remoteCwd = useSessionStore((s) => s.cwdBySession[sessionId]);

  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(
    async (p: string) => {
      if (!distro) return;
      setLoading(true);
      setError(undefined);
      try {
        const list = await wslFs.list(distro, p);
        setFiles(list);
        setPath(p);
        setSelected(undefined);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [distro],
  );

  // Initial load: resolve the distro's home directory, then list it.
  useEffect(() => {
    if (!distro) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const home = await wslFs.home(distro).catch(() => "/");
        if (cancelled) return;
        const list = await wslFs.list(distro, home);
        if (cancelled) return;
        setFiles(list);
        setPath(home);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, distro]);

  // Follow the terminal: when the working directory changes and auto-follow is
  // enabled, navigate the file listing to it. Manual navigation turns the follow
  // off (see `navigate`), so the panel stays where the user put it.
  useEffect(() => {
    if (autoFollow && remoteCwd && remoteCwd !== pathRef.current) {
      void load(remoteCwd);
    }
  }, [remoteCwd, autoFollow, load]);

  // Transfer progress → reload the listing when a transfer finishes.
  useEffect(() => {
    const un: Promise<UnlistenFn> = wslFs.onProgress((p) => {
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
  }, [distro, load]);

  const uploadPath = useCallback(
    async (localPath: string) => {
      if (!distro) return;
      const id = crypto.randomUUID();
      const name = localPath.split(/[\\/]/).pop() ?? "file";
      setTransfers((prev) => ({
        ...prev,
        [id]: { transferId: id, fileName: name, transferred: 0, total: 0, done: false },
      }));
      try {
        await wslFs.upload(distro, localPath, path, id);
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
    [distro, path],
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
    },
    [load],
  );

  const toggleFollow = useCallback(() => {
    setAutoFollow((on) => {
      const next = !on;
      if (next && remoteCwd) void load(remoteCwd);
      return next;
    });
  }, [remoteCwd, load]);

  const download = async (file: RemoteFile) => {
    const target = await pickSave(file.name);
    if (!target) return;
    const id = crypto.randomUUID();
    setTransfers((prev) => ({
      ...prev,
      [id]: { transferId: id, fileName: file.name, transferred: 0, total: file.size, done: false },
    }));
    try {
      if (distro) await wslFs.download(distro, file.path, target, id);
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
      if (distro) await wslFs.rename(distro, file.path, to);
      void load(path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const doDelete = async (file: RemoteFile) => {
    if (!window.confirm(`Delete ${file.isDir ? "folder" : "file"} "${file.name}"?`)) return;
    try {
      if (distro) await wslFs.remove(distro, file.path, file.isDir);
      void load(path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const newFolder = async () => {
    const name = window.prompt("New folder name");
    if (!name) return;
    try {
      if (distro) await wslFs.mkdir(distro, `${path === "/" ? "" : path}/${name}`);
      void load(path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const [menu, setMenu] = useState<{ x: number; y: number; file: RemoteFile } | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // Drag-and-drop upload. Tauri dispatches a window-level drag-drop event while
  // this panel is mounted, so any file dropped into the app uploads to the
  // current directory. Unmounting (closing the panel) stops listening.
  useEffect(() => {
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
        // "enter" / "over": pointer is over the window, show the drop hint.
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
  }, [uploadPath]);

  const activeTransfers = Object.values(transfers);
  const visible = showHidden ? files : files.filter((f) => !f.name.startsWith("."));

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
      {/* Path bar */}
      <div className="flex h-9 items-center gap-1 border-b border-border px-2.5">
        <Button variant="ghost" size="sm" onClick={() => navigate("/")} title="Root">
          <Home size={14} />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => navigate(parentPath(path))} title="Up">
          <ArrowUp size={14} />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void load(path)} title="Refresh">
          <RefreshCw size={14} />
        </Button>
        <div className="min-w-0 flex-1 select-text truncate px-1 font-mono text-[11px] text-muted">
          {path}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} title="Close WSL file manager">
          <X size={14} />
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <Button
          variant={autoFollow ? "primary" : "secondary"}
          size="sm"
          onClick={toggleFollow}
          title="Follow the terminal's current directory"
        >
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
        <Button
          variant="secondary"
          size="sm"
          onClick={uploadHere}
          title="Upload files (or drop them onto the panel)"
        >
          <Upload size={13} /> Upload
        </Button>
      </div>

      {/* File list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!distro && !error ? (
          <p className="p-4 text-[12px] text-subtle">Resolving distro…</p>
        ) : loading && files.length === 0 ? (
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
                  onDoubleClick={() => (f.isDir ? navigate(f.path) : void download(f))}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ x: e.clientX, y: e.clientY, file: f });
                  }}
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
                  <td className="max-w-[120px] truncate py-1.5 pr-2 font-mono text-fg">
                    {f.name}
                  </td>
                  <td className="px-2 text-right text-muted">{formatBytes(f.size)}</td>
                  <td className="hidden px-2 text-subtle sm:table-cell">
                    {formatPermissions(f.permissions, f.isDir)}
                  </td>
                  <td className="hidden px-2 text-subtle md:table-cell">
                    {formatMtime(f.modified)}
                  </td>
                  <td className="pr-2 text-right">
                    <span className="invisible flex justify-end gap-1 group-hover:visible">
                      {!f.isDir && (
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

      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-[140px] overflow-hidden rounded-md border border-border bg-elevated py-1 shadow-lg"
            style={{ left: menu.x, top: menu.y }}
          >
            {!menu.file.isDir && (
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-hover"
                onClick={() => {
                  setMenu(null);
                  void download(menu.file);
                }}
              >
                <Download size={13} /> Download
              </button>
            )}
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-hover"
              onClick={() => {
                setMenu(null);
                void doRename(menu.file);
              }}
            >
              <Pencil size={13} /> Rename
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-danger hover:bg-hover"
              onClick={() => {
                setMenu(null);
                void doDelete(menu.file);
              }}
            >
              <Trash2 size={13} /> Delete
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg hover:bg-hover"
              onClick={() => {
                setMenu(null);
                void uploadHere();
              }}
            >
              <Upload size={13} /> Upload here
            </button>
          </div>
        </>
      )}
    </div>
  );
}
