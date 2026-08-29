import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowUp,
  Check,
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
  Pencil,
  RefreshCw,
  RotateCw,
  Server,
  Sparkles,
  Trash2,
  Unplug,
  Upload,
  X,
  ChevronDown,
} from "lucide-react";

import { localFs, sftp, ssh } from "@/lib/api";
import { Bar, Badge, Button, Dialog, Input, SideIconButton } from "@/components/ui";
import { RemoteFileEditor } from "./RemoteFileEditor";
import { RemoteFilePreview } from "./RemoteFilePreview";
import { PermsDialog } from "./PermsDialog";
import { cn, formatBytes, formatMtime, parentPath } from "@/lib/utils";
import { explainFile, diffFiles } from "@/ai/tasks";
import { connectSshWithHostKeyPrompt } from "@/lib/sshConnect";
import { useHostsStore } from "@/store/useHostsStore";
import { useT } from "@/i18n";
import type {
  Host,
  LocalEntry,
  RemoteFile,
  SshConnectConfig,
  TransferProgress,
} from "@/lib/types";

/** Which pane a file (or a drop target) lives in. */
type Side = "left" | "right";

/**
 * What a pane is browsing. The left pane is always the tab's remote host; the
 * right pane defaults to this machine but can be switched to another host.
 */
type Source =
  | { kind: "local" }
  | { kind: "remote"; sessionId: string; hostId: string; label: string };

const other = (side: Side): Side => (side === "left" ? "right" : "left");

interface DragItem {
  side: Side;
  path: string;
  name: string;
  isDir: boolean;
}

interface DragState {
  item: DragItem;
  x: number;
  y: number;
  active: boolean;
  over: Side | null;
  overFolder: { side: Side; path: string } | null;
}

/** Everything needed to resume a failed transfer from its last byte offset. */
type TransferMeta =
  | { kind: "up"; sessionId: string; localPath: string; remoteDir: string }
  | { kind: "down"; sessionId: string; remotePath: string; localPath: string }
  | {
      kind: "copy";
      fromSessionId: string;
      toSessionId: string;
      remotePath: string;
      remoteDir: string;
    };

/** A file targeted by one of the inline dialogs (editor / preview / …). */
interface FileTarget {
  side: Side;
  sessionId: string;
  path: string;
  name: string;
}

/** A file targeted by the rename / delete / permission dialogs. */
interface RowTarget {
  side: Side;
  sessionId: string;
  file: RemoteFile;
}

/** Normalize a local listing entry to the shape both panes render. */
function localToRemote(e: LocalEntry): RemoteFile {
  return {
    name: e.name,
    path: e.path,
    isDir: e.isDir,
    isSymlink: false,
    size: e.size,
    modified: e.modified,
    permissions: 0,
    owner: null,
    group: null,
  };
}

/** POSIX join for remote paths (mirrors `remote_join` in the Rust backend). */
function remoteJoin(dir: string, name: string): string {
  if (!dir || dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
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

function RowAction({
  icon,
  label,
  tone,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  tone?: "default" | "danger";
  onClick: () => void;
}) {
  return (
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
}

/**
 * Hover action cluster for a *remote* row — shared by both panes so the two
 * sides behave identically (preview / send across / edit / chmod / rename /
 * delete).
 */
function RemoteRowActions({
  file,
  sendIcon,
  sendLabel,
  onPreview,
  onSend,
  onEdit,
  onPerms,
  onRename,
  onDelete,
}: {
  file: RemoteFile;
  sendIcon: ReactNode;
  sendLabel: string;
  onPreview: () => void;
  onSend: () => void;
  onEdit: () => void;
  onPerms: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  return (
    <span className="invisible flex shrink-0 items-center gap-0.5 group-hover:visible">
      {!file.isDir && <RowAction icon={<Eye size={13} />} label="Preview" onClick={onPreview} />}
      {!file.isDir && <RowAction icon={sendIcon} label={sendLabel} onClick={onSend} />}
      <RowAction icon={<FilePen size={13} />} label="Edit file" onClick={onEdit} />
      <RowAction
        icon={<KeyRound size={13} />}
        label="Permissions (chmod / chown)"
        onClick={onPerms}
      />
      <RowAction icon={<Pencil size={13} />} label="Rename" onClick={onRename} />
      <RowAction icon={<Trash2 size={13} />} label="Delete" tone="danger" onClick={onDelete} />
    </span>
  );
}

/**
 * Right-pane source switcher — a custom dropdown (instead of a native `<select>`
 * so the open list matches the app's dark styling instead of the OS combobox).
 */
function SourcePicker({
  value,
  hosts,
  connecting,
  onChange,
}: {
  value: Source;
  hosts: Host[];
  connecting: string | null;
  onChange: (v: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const label = value.kind === "local" ? t("sftp.sourceLocal") : value.label;
  const rowCls =
    "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-accent/10 hover:text-accent";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        disabled={!!connecting}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-7 w-[170px] items-center gap-1.5 rounded-md border border-border/70 bg-bg px-2.5 text-[11px] text-fg transition-colors hover:border-accent/40",
          connecting && "opacity-60",
        )}
        title={value.kind === "remote" ? value.label : t("sftp.sourceLocal")}
      >
        {value.kind === "local" ? (
          <HardDrive size={13} className="shrink-0 text-muted" />
        ) : (
          <Server size={13} className="shrink-0 text-accent" />
        )}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {connecting ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
        ) : (
          <ChevronDown size={13} className="shrink-0 text-subtle" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-[220px] overflow-hidden rounded-lg border border-border bg-elevated py-1 shadow-2xl">
          <button
            type="button"
            onClick={() => {
              onChange("local");
              setOpen(false);
            }}
            className={rowCls}
          >
            <HardDrive size={14} className="shrink-0 text-muted" />
            <span className="truncate">{t("sftp.sourceLocal")}</span>
          </button>

          <div className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-subtle">
            {t("sftp.sourceRemote")}
          </div>
          {hosts.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => {
                onChange(h.id);
                setOpen(false);
              }}
              className={rowCls}
            >
              <Server size={14} className="shrink-0 text-accent" />
              <span className="min-w-0 flex-1 truncate">{h.name}</span>
            </button>
          ))}
          {value.kind === "remote" && (
            <button
              type="button"
              onClick={() => {
                onChange("__disconnect__");
                setOpen(false);
              }}
              className={cn(rowCls, "text-danger hover:!bg-danger/10 hover:!text-danger")}
            >
              <Unplug size={14} className="shrink-0" />
              <span className="truncate">{t("sftp.disconnectRight")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Dual-pane SFTP file manager with a modern, card-based UI. The left pane is
 * the tab's remote host; the right pane is switchable between this machine and
 * another remote host (remote ⇄ remote transfers never touch local disk).
 * Drag & drop is mouse-driven (WebView2-safe, no HTML5 DnD): mousedown → move
 * past threshold → floating preview → mouseup commits.
 */
export function SftpDualPanel({ sessionId }: { sessionId: string }) {
  const t = useT();
  const hosts = useHostsStore((s) => s.hosts);
  const sshHosts = useMemo(() => hosts.filter((h) => h.kind === "ssh"), [hosts]);

  // --- Left pane state (always the tab's remote host) ---
  const [rPath, setRPath] = useState("/");
  const [rFiles, setRFiles] = useState<RemoteFile[]>([]);
  const [rLoading, setRLoading] = useState(true);
  const [rError, setRError] = useState<string | undefined>();
  const [rShowHidden, setRShowHidden] = useState(false);
  const [rSelected, setRSelected] = useState<string | undefined>();
  const rPathRef = useRef(rPath);
  rPathRef.current = rPath;

  // --- Right pane state (switchable: this machine or another remote host) ---
  const [rightSource, setRightSource] = useState<Source>({ kind: "local" });
  const [rightPath, setRightPath] = useState("");
  const [rightFiles, setRightFiles] = useState<RemoteFile[]>([]);
  const [rightLoading, setRightLoading] = useState(true);
  const [rightError, setRightError] = useState<string | undefined>();
  const [rightShowHidden, setRightShowHidden] = useState(false);
  const [rightSelected, setRightSelected] = useState<string | undefined>();
  /** Name of the host being connected to (right pane), while in flight. */
  const [rightConnecting, setRightConnecting] = useState<string | null>(null);
  const [rightConnectError, setRightConnectError] = useState<string | undefined>();
  const rightPathRef = useRef(rightPath);
  rightPathRef.current = rightPath;
  // Read by async handlers (loaders, transfers) that must not re-bind on change.
  const rightSourceRef = useRef(rightSource);
  rightSourceRef.current = rightSource;
  const rightHomeRef = useRef("");
  const rightSessionRef = useRef<string | undefined>(undefined);
  rightSessionRef.current = rightSource.kind === "remote" ? rightSource.sessionId : undefined;
  /** Bumped on every source switch/navigation so stale listings are discarded. */
  const rightGen = useRef(0);

  // --- Shared transfer + drag state ---
  const [transfers, setTransfers] = useState<Record<string, TransferProgress>>({});
  const transferSide = useRef<Record<string, Side>>({});
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [osDrag, setOsDrag] = useState(false);

  // --- Inline remote-file editor + permission dialog ---
  const [editing, setEditing] = useState<FileTarget | null>(null);
  const [permTarget, setPermTarget] = useState<RowTarget | null>(null);

  // --- Styled dialogs replacing native window.prompt / window.confirm ---
  const [newFolderSide, setNewFolderSide] = useState<Side | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<RowTarget | null>(null);
  const [renameName, setRenameName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<RowTarget | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffPath, setDiffPath] = useState("");

  // --- Remote-file preview (images, PDF, video, audio, Markdown, text) ---
  const [preview, setPreview] = useState<FileTarget | null>(null);

  // Remembers the source/target of each transfer so a failed one can be resumed
  // from the last acknowledged byte offset.
  const transferMeta = useRef<Record<string, TransferMeta>>({});

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

  /** List `p` in the right pane, whatever it is currently browsing. */
  const loadRight = useCallback(async (p: string) => {
    const source = rightSourceRef.current;
    const gen = ++rightGen.current;
    const stale = () => rightGen.current !== gen;
    setRightLoading(true);
    setRightError(undefined);
    // Navigating away dismisses a stale "connection failed" notice.
    setRightConnectError(undefined);
    try {
      const list =
        source.kind === "local"
          ? (await localFs.list(p)).map(localToRemote)
          : await sftp.list(source.sessionId, p);
      if (stale()) return;
      setRightFiles(list);
      setRightPath(p);
      setRightSelected(undefined);
    } catch (e) {
      if (stale()) return;
      setRightError((e as Error).message);
    } finally {
      if (!stale()) setRightLoading(false);
    }
  }, []);

  const reloadSide = useCallback(
    (side: Side) => {
      if (side === "left") void loadRemote(rPathRef.current);
      else void loadRight(rightPathRef.current);
    },
    [loadRemote, loadRight],
  );

  // Initial load for the left pane: remote home via realpath(".").
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

  // Initial load for the right pane: re-runs whenever its source changes.
  useEffect(() => {
    const source = rightSource;
    const gen = ++rightGen.current;
    const stale = () => rightGen.current !== gen;
    let cancelled = false;
    (async () => {
      setRightLoading(true);
      setRightError(undefined);
      try {
        const home =
          source.kind === "local"
            ? await localFs.home()
            : await sftp.realpath(source.sessionId, ".").catch(() => "/");
        rightHomeRef.current = home;
        const list =
          source.kind === "local"
            ? (await localFs.list(home)).map(localToRemote)
            : await sftp.list(source.sessionId, home);
        if (cancelled || stale()) return;
        setRightFiles(list);
        setRightPath(home);
        setRightSelected(undefined);
      } catch (e) {
        if (!cancelled && !stale()) setRightError((e as Error).message);
      } finally {
        if (!cancelled && !stale()) setRightLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rightSource]);

  // Close the right pane's session when the panel goes away (switching sources
  // disconnects the previous one eagerly, see `changeRight`).
  useEffect(
    () => () => {
      const sid = rightSessionRef.current;
      if (sid) void ssh.disconnect(sid).catch(() => {});
    },
    [],
  );

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
          if (side) reloadSide(side);
        }, 500);
      }
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, [reloadSide]);

  // --- Right pane source switching ---

  /** Drop transfer rows bound to a session that is about to be disconnected. */
  const dropTransfersFor = (sid: string) => {
    const ids = Object.entries(transferMeta.current)
      .filter(([, m]) =>
        m.kind === "copy"
          ? m.fromSessionId === sid || m.toSessionId === sid
          : m.sessionId === sid,
      )
      .map(([id]) => id);
    if (ids.length === 0) return;
    setTransfers((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    for (const id of ids) {
      delete transferSide.current[id];
      delete transferMeta.current[id];
    }
  };

  const changeRight = useCallback(
    async (value: string) => {
      const prev = rightSourceRef.current;
      const currentValue = prev.kind === "remote" ? prev.hostId : "local";
      if (value === currentValue) return;

      if (prev.kind === "remote") {
        void ssh.disconnect(prev.sessionId).catch(() => {});
        dropTransfersFor(prev.sessionId);
      }
      // Invalidate anything still in flight for the old source.
      rightGen.current++;
      setRightFiles([]);
      setRightSelected(undefined);
      setRightError(undefined);
      setRightConnectError(undefined);

      const host: Host | undefined = sshHosts.find((h) => h.id === value);
      if (!host) {
        setRightSource({ kind: "local" });
        return;
      }

      const config: SshConnectConfig = {
        hostId: host.id,
        hostname: host.hostname ?? "",
        port: host.port ?? 22,
        username: host.username ?? "",
        // Sentinel — the backend swaps it for the decrypted secret.
        password: host.password ?? undefined,
        privateKeyPath: host.privateKeyPath ?? undefined,
        passphrase: host.passphrase ?? undefined,
        cols: 120,
        rows: 32,
        term: "xterm-256color",
      };

      setRightConnecting(host.name);
      try {
        const result = await connectSshWithHostKeyPrompt(config);
        setRightSource({
          kind: "remote",
          sessionId: result.sessionId,
          hostId: host.id,
          label: host.name,
        });
      } catch (e) {
        setRightConnectError((e as Error).message);
        setRightSource({ kind: "local" });
      } finally {
        setRightConnecting(null);
      }
    },
    [sshHosts],
  );

  // --- Transfers ---

  const sessionOf = (side: Side): string | undefined =>
    side === "left"
      ? sessionId
      : rightSourceRef.current.kind === "remote"
        ? rightSourceRef.current.sessionId
        : undefined;

  const seedTransfer = (id: string, name: string, offset?: number) =>
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

  const failTransfer =
    (id: string) =>
    (e: unknown) =>
      setTransfers((prev) => ({
        ...prev,
        [id]: { ...prev[id], done: true, error: (e as Error).message },
      }));

  const startUpload = (
    localPath: string,
    target: Side,
    remoteDir: string,
    offset?: number,
  ) => {
    const sid = sessionOf(target);
    if (!sid) return;
    const id = crypto.randomUUID();
    const name = localPath.split(/[\\/]/).pop() ?? "file";
    transferSide.current[id] = target;
    transferMeta.current[id] = { kind: "up", sessionId: sid, localPath, remoteDir };
    seedTransfer(id, name, offset);
    void sftp.upload(sid, localPath, remoteDir, id, offset).catch(failTransfer(id));
  };

  const startDownload = (
    from: Side,
    remotePath: string,
    name: string,
    localDir: string,
    offset?: number,
  ) => {
    const sid = sessionOf(from);
    if (!sid) return;
    const id = crypto.randomUUID();
    const localPath = joinLocal(localDir, name);
    transferSide.current[id] = other(from);
    transferMeta.current[id] = { kind: "down", sessionId: sid, remotePath, localPath };
    seedTransfer(id, name, offset);
    void sftp.download(sid, remotePath, localPath, id, offset).catch(failTransfer(id));
  };

  /** Remote ⇄ remote: streamed host-to-host by the backend, no local disk. */
  const startRemoteCopy = (
    from: Side,
    remotePath: string,
    to: Side,
    remoteDir: string,
    offset?: number,
  ) => {
    const fromSid = sessionOf(from);
    const toSid = sessionOf(to);
    if (!fromSid || !toSid) return;
    const id = crypto.randomUUID();
    transferSide.current[id] = to;
    transferMeta.current[id] = {
      kind: "copy",
      fromSessionId: fromSid,
      toSessionId: toSid,
      remotePath,
      remoteDir,
    };
    seedTransfer(id, remotePath.split("/").pop() ?? remotePath, offset);
    void sftp
      .remoteCopy(fromSid, toSid, remotePath, remoteDir, id, offset)
      .catch(failTransfer(id));
  };

  /** Send a file to the opposite pane's current directory. */
  const sendToOther = (from: Side, item: DragItem, targetDir?: string) => {
    const to = other(from);
    const dir = targetDir ?? (to === "left" ? rPathRef.current : rightPathRef.current);
    // The left pane is always remote, so only the right pane can be local.
    if (from === "right" && rightSourceRef.current.kind === "local") {
      startUpload(item.path, to, dir);
    } else if (to === "right" && rightSourceRef.current.kind === "local") {
      startDownload(from, item.path, item.name, dir);
    } else {
      startRemoteCopy(from, item.path, to, dir);
    }
  };

  // Resume a failed transfer from the last acknowledged byte offset. Reuses the
  // same transfer id so the existing row updates in place.
  const resumeTransfer = (tr: TransferProgress) => {
    const meta = transferMeta.current[tr.transferId];
    if (!meta) return;
    const offset = tr.transferred;
    const tid = tr.transferId;
    setTransfers((prev) => ({
      ...prev,
      [tid]: { ...prev[tid], done: false, error: null },
    }));
    const fail = failTransfer(tid);
    if (meta.kind === "up") {
      void sftp.upload(meta.sessionId, meta.localPath, meta.remoteDir, tid, offset).catch(fail);
    } else if (meta.kind === "down") {
      void sftp
        .download(meta.sessionId, meta.remotePath, meta.localPath, tid, offset)
        .catch(fail);
    } else {
      void sftp
        .remoteCopy(
          meta.fromSessionId,
          meta.toSessionId,
          meta.remotePath,
          meta.remoteDir,
          tid,
          offset,
        )
        .catch(fail);
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
        ? { side: d.over, path: d.over === "left" ? rPathRef.current : rightPathRef.current }
        : null;
    if (!target) return false;
    if (d.item.side === target.side) return false; // same side — nothing to transfer
    sendToOther(d.item.side, d.item, target.path);
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

  // OS-level file drop anywhere on the window uploads to the left (remote) pane.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
      const p = getCurrentWebview().onDragDropEvent((event) => {
        const e = event.payload;
        if (e.type === "drop") {
          setOsDrag(false);
          for (const localPath of e.paths) startUpload(localPath, "left", rPathRef.current);
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
  /** Pick local files and upload them into `target`'s current directory. */
  const uploadHere = async (target: Side) => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ multiple: true, title: "Select files to upload" });
      if (!picked) return;
      const dir = target === "left" ? rPath : rightPathRef.current;
      for (const p of Array.isArray(picked) ? picked : [picked]) startUpload(p, target, dir);
    } catch {
      alert("File pickers require the desktop app.");
    }
  };

  const submitNewFolder = async () => {
    const side = newFolderSide;
    const name = newFolderName.trim();
    setNewFolderSide(null);
    setNewFolderName("");
    if (!side || !name) return;
    const dir = side === "left" ? rPath : rightPathRef.current;
    const sid = sessionOf(side);
    try {
      if (sid) await sftp.mkdir(sid, remoteJoin(dir, name));
      else await localFs.mkdir(remoteJoin(dir, name));
      reloadSide(side);
    } catch (e) {
      setErrorFor(side, (e as Error).message);
    }
  };

  const setErrorFor = (side: Side, message: string) => {
    if (side === "left") setRError(message);
    else setRightError(message);
  };

  const submitRename = async () => {
    const next = renameName.trim();
    if (!renameTarget || !next || next === renameTarget.file.name) {
      setRenameTarget(null);
      return;
    }
    const dir = renameTarget.side === "left" ? rPathRef.current : rightPathRef.current;
    const to = remoteJoin(dir, next);
    const target = renameTarget;
    setRenameTarget(null);
    try {
      await sftp.rename(target.sessionId, target.file.path, to);
      reloadSide(target.side);
    } catch (e) {
      setErrorFor(target.side, (e as Error).message);
    }
  };

  const submitDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await sftp.remove(target.sessionId, target.file.path, target.file.isDir);
      reloadSide(target.side);
    } catch (e) {
      setErrorFor(target.side, (e as Error).message);
    }
  };

  const submitDiff = () => {
    const otherPath = diffPath.trim();
    setDiffOpen(false);
    if (!rSelected || !otherPath) return;
    void diffFiles(sessionId, rSelected, otherPath);
  };

  const rVisible = rShowHidden ? rFiles : rFiles.filter((f) => !f.name.startsWith("."));
  const rightVisible = rightShowHidden
    ? rightFiles
    : rightFiles.filter((f) => !f.name.startsWith("."));
  const activeTransfers = Object.values(transfers);

  const rightIsRemote = rightSource.kind === "remote";
  const rightHeaderError = rightError ?? rightConnectError;

  // Shared row props for a pane's file rows.
  const rowDragProps = (item: DragItem, selected: boolean, folderHover: boolean) => ({
    onMouseDown: (e: ReactMouseEvent) => startRowDrag(e, item),
    onClick: () => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      if (item.side === "left") setRSelected(item.path === rSelected ? undefined : item.path);
      else setRightSelected(item.path === rightSelected ? undefined : item.path);
    },
    onMouseEnter: () => {
      if (item.isDir) patchDrag({ overFolder: { side: item.side, path: item.path } });
    },
    onMouseLeave: () => {
      if (
        dragRef.current?.overFolder?.path === item.path &&
        dragRef.current.overFolder.side === item.side
      ) {
        patchDrag({ overFolder: null });
      }
    },
    className: cn(
      "group flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[12px] transition-colors hover:bg-hover",
      selected && "bg-accent/10 hover:bg-accent/15",
      folderHover && "bg-accent/15 ring-1 ring-inset ring-accent/40",
    ),
  });

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
              "bg-accent/15 text-accent",
            )}
          >
            {drag.item.side === "left" ? "→ right" : "→ left"}
          </span>
        </div>
      )}

      {/* Hint strip */}
      <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-surface px-2.5 text-[11px] text-subtle">
        <ArrowLeftRight size={13} className="text-accent" />
        <span>
          <span className="font-medium text-accent">Remote</span> ⇄{" "}
          <span className="font-medium text-muted">
            {rightIsRemote ? "Remote" : "Local"}
          </span>{" "}
          — drag files across to transfer
        </span>
      </div>

      {/* Two panes */}
      <div className="flex min-h-0 flex-1 gap-2">
        {/* ============ Left pane (always the tab's remote host) ============ */}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-surface transition-shadow",
            drag?.over === "left" && drag.active && "border-accent/50 ring-2 ring-accent/30",
          )}
          onMouseEnter={() => patchDrag({ over: "left" })}
          onMouseLeave={() => {
            const cur = dragRef.current;
            if (!cur) return;
            patchDrag({
              over: null,
              overFolder: cur.overFolder?.side === "left" ? null : cur.overFolder,
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
              variant={rShowHidden ? "primary" : "secondary"}
              size="sm"
              onClick={() => setRShowHidden((v) => !v)}
              title={rShowHidden ? "Hide hidden files" : "Show hidden files"}
            >
              {rShowHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              Hidden
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setNewFolderSide("left")} title="New folder">
              <FolderPlus size={13} /> New
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void uploadHere("left")} title="Upload local files (or drop them anywhere)">
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
                  const item: DragItem = { side: "left", path: f.path, name: f.name, isDir: f.isDir };
                  const selected = rSelected === f.path;
                  const folderHover = drag?.overFolder?.side === "left" && drag.overFolder.path === f.path;
                  return (
                    <div
                      key={f.path}
                      {...rowDragProps(item, selected, !!folderHover)}
                      onDoubleClick={() =>
                        f.isDir
                          ? void loadRemote(f.path)
                          : setPreview({ side: "left", sessionId, path: f.path, name: f.name })
                      }
                      title={
                        f.isDir
                          ? "Double-click to open"
                          : "Double-click to edit · drag to the other side to transfer"
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
                      <RemoteRowActions
                        file={f}
                        sendIcon={<ArrowRight size={13} />}
                        sendLabel={rightIsRemote ? "Copy to the other host" : "Download to local folder"}
                        onPreview={() =>
                          setPreview({ side: "left", sessionId, path: f.path, name: f.name })
                        }
                        onSend={() => sendToOther("left", item)}
                        onEdit={() => setEditing({ side: "left", sessionId, path: f.path, name: f.name })}
                        onPerms={() => setPermTarget({ side: "left", sessionId, file: f })}
                        onRename={() => {
                          setRenameName(f.name);
                          setRenameTarget({ side: "left", sessionId, file: f });
                        }}
                        onDelete={() => setDeleteTarget({ side: "left", sessionId, file: f })}
                      />
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

        {/* ============ Right pane (this machine or another remote host) ============ */}
        <div
          className={cn(
            "flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-surface transition-shadow",
            drag?.over === "right" && drag.active && "border-accent/50 ring-2 ring-accent/30",
          )}
          onMouseEnter={() => patchDrag({ over: "right" })}
          onMouseLeave={() => {
            const cur = dragRef.current;
            if (!cur) return;
            patchDrag({
              over: null,
              overFolder: cur.overFolder?.side === "right" ? null : cur.overFolder,
            });
          }}
        >
          {/* Pane header: icon chip + nav + path + source picker */}
          <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border/60 px-2">
            <span className="icon-chip h-6 w-6 shrink-0">
              {rightIsRemote ? (
                <Server size={13} className="text-accent" />
              ) : (
                <HardDrive size={13} className="text-muted" />
              )}
            </span>
            <SideIconButton
              label="Home"
              onClick={() => rightHomeRef.current && void loadRight(rightHomeRef.current)}
              icon={<Home size={14} />}
            />
            <SideIconButton
              label="Up"
              onClick={() =>
                void loadRight(rightIsRemote ? parentPath(rightPath) : localParent(rightPath))
              }
              icon={<ArrowUp size={14} />}
            />
            <SideIconButton label="Refresh" onClick={() => void loadRight(rightPath)} icon={<RefreshCw size={14} />} />
            <Input
              value={rightPath || "loading…"}
              readOnly
              spellCheck={false}
              className="h-7 flex-1 px-2 font-mono text-[11px]"
            />
            <SourcePicker
              value={rightSource}
              hosts={sshHosts}
              connecting={rightConnecting}
              onChange={(v) => void changeRight(v)}
            />
          </div>

          {/* Toolbar */}
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border/60 px-2 py-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setNewFolderSide("right")}
              title="New folder"
            >
              <FolderPlus size={13} /> New
            </Button>
            {rightIsRemote && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void uploadHere("right")}
                title="Upload local files to this host"
              >
                <Upload size={13} /> Upload
              </Button>
            )}
            <Button
              variant={rightShowHidden ? "primary" : "secondary"}
              size="sm"
              onClick={() => setRightShowHidden((v) => !v)}
              title={rightShowHidden ? "Hide hidden files" : "Show hidden files"}
            >
              {rightShowHidden ? <EyeOff size={13} /> : <Eye size={13} />}
              Hidden
            </Button>
            <span className="ml-auto text-[11px] text-subtle">
              {rightIsRemote
                ? "Drop files here to copy across hosts"
                : "Drop remote files here to download"}
            </span>
          </div>

          {/* File list */}
          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {rightConnecting ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-subtle">
                <Loader2 size={14} className="animate-spin text-accent" />
                {t("sftp.connecting", { name: rightConnecting })}
              </div>
            ) : rightLoading && rightFiles.length === 0 ? (
              <div className="flex h-full items-center justify-center gap-2 text-[12px] text-subtle">
                <Loader2 size={14} className="animate-spin text-accent" /> Loading…
              </div>
            ) : rightHeaderError && rightFiles.length === 0 ? (
              <div className="flex h-full items-center justify-center gap-2 px-4 text-[12px] text-danger">
                <AlertCircle size={14} /> {rightHeaderError}
              </div>
            ) : (
              <>
                {rightHeaderError && (
                  <div className="mb-1 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
                    <AlertCircle size={13} className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate" title={rightHeaderError}>
                      {rightHeaderError}
                    </span>
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={() => {
                        setRightError(undefined);
                        setRightConnectError(undefined);
                      }}
                      className="shrink-0 rounded p-0.5 hover:bg-danger/10"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}
                <div className="space-y-0.5">
                {rightVisible.map((f) => {
                  const item: DragItem = {
                    side: "right",
                    path: f.path,
                    name: f.name,
                    isDir: f.isDir,
                  };
                  const selected = rightSelected === f.path;
                  const folderHover =
                    drag?.overFolder?.side === "right" && drag.overFolder.path === f.path;
                  return (
                    <div
                      key={f.path}
                      {...rowDragProps(item, selected, !!folderHover)}
                      onDoubleClick={() =>
                        f.isDir
                          ? void loadRight(f.path)
                          : rightSource.kind === "remote" &&
                            setPreview({
                              side: "right",
                              sessionId: rightSource.sessionId,
                              path: f.path,
                              name: f.name,
                            })
                      }
                      title={
                        f.isDir
                          ? "Double-click to open"
                          : "Drag to the other side to transfer"
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
                      {rightSource.kind === "remote" ? (
                        <RemoteRowActions
                          file={f}
                          sendIcon={<ArrowLeft size={13} />}
                          sendLabel="Copy to the other host"
                          onPreview={() =>
                            setPreview({
                              side: "right",
                              sessionId: rightSource.sessionId,
                              path: f.path,
                              name: f.name,
                            })
                          }
                          onSend={() => sendToOther("right", item)}
                          onEdit={() =>
                            setEditing({
                              side: "right",
                              sessionId: rightSource.sessionId,
                              path: f.path,
                              name: f.name,
                            })
                          }
                          onPerms={() =>
                            setPermTarget({
                              side: "right",
                              sessionId: rightSource.sessionId,
                              file: f,
                            })
                          }
                          onRename={() => {
                            setRenameName(f.name);
                            setRenameTarget({
                              side: "right",
                              sessionId: rightSource.sessionId,
                              file: f,
                            });
                          }}
                          onDelete={() =>
                            setDeleteTarget({
                              side: "right",
                              sessionId: rightSource.sessionId,
                              file: f,
                            })
                          }
                        />
                      ) : (
                        <span className="w-7 shrink-0" />
                      )}
                    </div>
                  );
                })}
                {rightVisible.length === 0 && (
                  <div className="flex flex-col items-center justify-center gap-1.5 py-12 text-[12px] text-subtle">
                    {rightIsRemote ? (
                      <Server size={22} className="text-border" />
                    ) : (
                      <HardDrive size={22} className="text-border" />
                    )}
                    {rightIsRemote
                      ? "Empty directory — drop files here to copy across"
                      : "Empty folder — drop remote files here to download"}
                  </div>
                )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Transfers */}
      {activeTransfers.length > 0 && (
        <div className="max-h-36 shrink-0 space-y-1.5 overflow-y-auto rounded-lg border border-border/60 bg-surface px-3 py-2">
          {activeTransfers.map((tr) => {
            const pct = tr.total > 0 ? (tr.transferred / tr.total) * 100 : tr.done ? 100 : 0;
            return (
              <div key={tr.transferId} className="flex items-center gap-2 text-[11px]">
                {tr.done ? (
                  tr.error ? (
                    <AlertCircle size={13} className="shrink-0 text-danger" />
                  ) : (
                    <Check size={13} className="shrink-0 text-success" />
                  )
                ) : (
                  <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
                )}
                <span className="min-w-0 flex-1 truncate text-muted">{tr.fileName}</span>
                <span className="w-10 shrink-0 text-right text-subtle">
                  {tr.done ? (tr.error ? "error" : "done") : `${Math.round(pct)}%`}
                </span>
                <div className="w-24 shrink-0">
                  <Bar value={pct} tone={tr.error ? "danger" : "accent"} />
                </div>
                {tr.error ? (
                  <>
                    <span className="max-w-[200px] truncate text-[10px] text-danger" title={tr.error}>
                      {tr.error}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-1.5"
                      onClick={() => resumeTransfer(tr)}
                      title="Resume from the last transferred byte"
                    >
                      <RotateCw size={12} /> Resume
                    </Button>
                  </>
                ) : (
                  tr.done && <Check size={13} className="shrink-0 text-success" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Inline remote-file editor */}
      {editing && (
        <RemoteFileEditor
          sessionId={editing.sessionId}
          path={editing.path}
          name={editing.name}
          onClose={() => setEditing(null)}
          onSaved={() => reloadSide(editing.side)}
          onDownload={(p, n) => sendToOther(editing.side, { side: editing.side, path: p, name: n, isDir: false })}
        />
      )}

      {/* Remote-file preview (images, PDF, video, audio, Markdown, text) */}
      {preview && (
        <RemoteFilePreview
          sessionId={preview.sessionId}
          path={preview.path}
          name={preview.name}
          onClose={() => setPreview(null)}
          onEdit={(p, n) => setEditing({ side: preview.side, sessionId: preview.sessionId, path: p, name: n })}
          onDownload={(p, n) => sendToOther(preview.side, { side: preview.side, path: p, name: n, isDir: false })}
        />
      )}

      {/* Permission editor (chmod / chown) */}
      {permTarget && (
        <PermsDialog
          sessionId={permTarget.sessionId}
          file={permTarget.file}
          onClose={() => setPermTarget(null)}
          onApplied={() => reloadSide(permTarget.side)}
        />
      )}

      {/* New folder */}
      <Dialog
        open={!!newFolderSide}
        onClose={() => {
          setNewFolderSide(null);
          setNewFolderName("");
        }}
        title="New folder"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => {
              setNewFolderSide(null);
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
            ? `Delete ${deleteTarget.file.isDir ? "folder" : "file"} "${deleteTarget.file.name}"? This cannot be undone.`
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
