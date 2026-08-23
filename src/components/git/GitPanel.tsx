import { useCallback, useEffect, useRef, useState } from "react";
import {
  Eye,
  GitBranch,
  GitCommit,
  GitMerge,
  History,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Upload,
  Download,
  RefreshCw as FetchIcon,
  X,
} from "lucide-react";

import { Button, Dialog, Input, Select, SideIconButton, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";
import { git } from "@/lib/api";
import type { GitBranches, GitCommit as GitCommitT, GitDiff, GitFileEntry, GitStatus } from "@/lib/types";
import { useT } from "@/i18n";

/**
 * A git sidebar mirroring the Files panel: docked on the right of the terminal
 * workspace, driven by the active terminal's cwd. For WSL sessions `cwd` is a
 * unix path and `distro` is passed so the backend can reach it over the
 * `\\wsl$\<distro>` UNC share.
 */
export function GitPanel({
  cwd,
  distro,
  sessionId,
  onClose,
}: {
  cwd: string;
  distro?: string;
  sessionId?: string;
  onClose: () => void;
}) {
  const t = useT();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [loading, setLoading] = useState(true);
  const [notRepo, setNotRepo] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [opResult, setOpResult] = useState<string | undefined>();
  const [commitMsg, setCommitMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");

  // Diff modal state: the file being inspected and its loaded diff.
  const [diffFile, setDiffFile] = useState<GitFileEntry | null>(null);
  const [diffText, setDiffText] = useState<string>("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | undefined>();
  const [diffBinary, setDiffBinary] = useState(false);

  // Commit log modal state.
  const [logOpen, setLogOpen] = useState(false);
  const [logCommits, setLogCommits] = useState<GitCommitT[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | undefined>();
  // Currently inspected commit in the log modal (shows its diff).
  const [logDetail, setLogDetail] = useState<GitCommitT | null>(null);
  const [logDetailText, setLogDetailText] = useState("");
  const [logDetailLoading, setLogDetailLoading] = useState(false);
  const [logDetailError, setLogDetailError] = useState<string | undefined>();
  const [logDetailBinary, setLogDetailBinary] = useState(false);
  // Reset confirmation dialog (reset --hard is destructive, so always confirm).
  const [resetOpen, setResetOpen] = useState(false);

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const distroRef = useRef(distro);
  distroRef.current = distro;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setOpResult(undefined);
    setNotRepo(false);
    try {
      // One batched call (one `wsl.exe` spawn on WSL, vs ~3 before).
      const snap = await git.snapshot(cwdRef.current, distroRef.current, sessionIdRef.current);
      setStatus(snap.status);
      setBranches(snap.branches);
    } catch (e) {
      const msg = (e as Error).message;
      // git exits non-zero in a non-repo; surface the empty state instead.
      if (/not a git repository|not a git repo|fatal: not/i.test(msg)) {
        setNotRepo(true);
        setStatus(null);
        setBranches(null);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, cwd, distro]);

  const runOp = useCallback(
    async (op: string, fn: () => Promise<string>): Promise<boolean> => {
      setBusy(true);
      setBusyOp(op);
      setError(undefined);
      setOpResult(undefined);
      try {
        const res = await fn();
        setOpResult(res && res.trim() ? res.trim() : t("git.done"));
        await refresh();
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      } finally {
        setBusy(false);
        setBusyOp(null);
      }
    },
    [refresh, t],
  );

  const openDiff = useCallback(
    async (entry: GitFileEntry) => {
      setDiffFile(entry);
      setDiffLoading(true);
      setDiffError(undefined);
      setDiffText("");
      setDiffBinary(false);
      try {
        const res = await git.diff(cwdRef.current, entry.path, entry.staged, distroRef.current, sessionIdRef.current);
        setDiffText(res.text);
        setDiffBinary(res.binary);
      } catch (e) {
        setDiffError((e as Error).message);
      } finally {
        setDiffLoading(false);
      }
    },
    [],
  );

  const openLog = useCallback(async () => {
    setLogOpen(true);
    setLogDetail(null);
    setLogLoading(true);
    setLogError(undefined);
    try {
      const commits = await git.log(cwdRef.current, distroRef.current, sessionIdRef.current);
      setLogCommits(commits);
    } catch (e) {
      setLogError((e as Error).message);
    } finally {
      setLogLoading(false);
    }
  }, []);

  const openCommitDetail = useCallback(async (commit: GitCommitT) => {
    setLogDetail(commit);
    setLogDetailLoading(true);
    setLogDetailError(undefined);
    setLogDetailText("");
    setLogDetailBinary(false);
    try {
      const res = await git.commitDiff(cwdRef.current, commit.hash, distroRef.current, sessionIdRef.current);
      setLogDetailText(res.text);
      setLogDetailBinary(res.binary);
    } catch (e) {
      setLogDetailError((e as Error).message);
    } finally {
      setLogDetailLoading(false);
    }
  }, []);

  const staged = status?.entries.filter((e) => e.staged) ?? [];
  const unstaged = status?.entries.filter((e) => e.unstaged || e.untracked) ?? [];

  const displayCwd = cwd.length > 42 ? "…" + cwd.slice(cwd.length - 41) : cwd;

  return (
    <div className="relative flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-surface">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <span className="icon-chip flex h-6 w-6 shrink-0 items-center justify-center">
          <GitBranch size={13} />
        </span>
        <span className="flex-1 truncate text-[12px] font-semibold text-fg" title={cwd}>
          {displayCwd}
        </span>
        <SideIconButton label={t("git.refresh")} onClick={() => void refresh()} icon={<RefreshCw size={14} />} />
        <SideIconButton label={t("git.log")} onClick={() => void openLog()} icon={<History size={14} />} />
        <SideIconButton label={t("git.close")} onClick={onClose} icon={<X size={14} />} />
      </div>

      {notRepo ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <GitBranch size={28} className="text-subtle" />
          <p className="text-[12px] text-subtle">{t("git.notRepo")}</p>
        </div>
      ) : loading && !status ? (
        <div className="flex flex-1 items-center justify-center p-4 text-[12px] text-subtle">
          <Loader2 size={16} className="animate-spin" />
        </div>
      ) : error ? (
        <div className="flex-1 overflow-y-auto p-3">
          <p className="whitespace-pre-wrap break-words text-[11px] text-danger">{error}</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Branch + sync toolbar */}
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] text-fg">
              <GitBranch size={13} className="shrink-0 text-accent" />
              <span className="truncate font-medium">{status?.branch}</span>
              {status?.upstream && (
                <span className="truncate text-[11px] text-subtle">→ {status.upstream}</span>
              )}
              {(status?.ahead ?? 0) > 0 && (
                <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-[10px] font-semibold text-accent">
                  {t("git.ahead", { n: status?.ahead ?? 0 })}
                </span>
              )}
              {(status?.behind ?? 0) > 0 && (
                <span className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-500">
                  {t("git.behind", { n: status?.behind ?? 0 })}
                </span>
              )}
            </div>
            <SideIconButton
              label={t("git.fetch")}
              onClick={() => void runOp("fetch", () => git.fetch(cwdRef.current, distroRef.current, sessionIdRef.current))}
              icon={<FetchIcon size={14} />}
            />
            <SideIconButton
              label={busy && busyOp === "pull" ? t("git.pulling") : t("git.pull")}
              onClick={() => void runOp("pull", () => git.pull(cwdRef.current, distroRef.current, sessionIdRef.current))}
              icon={busy && busyOp === "pull" ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            />
            <SideIconButton
              label={busy && busyOp === "push" ? t("git.pushing") : t("git.push")}
              onClick={() => void runOp("push", () => git.push(cwdRef.current, distroRef.current, sessionIdRef.current))}
              icon={busy && busyOp === "push" ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            />
          </div>

          {/* Branch switch */}
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Select
              value={status?.branch}
              onChange={(e) => {
                const b = e.target.value;
                if (b && b !== status?.branch) {
                  void runOp("checkout", () => git.checkout(cwdRef.current, b, distroRef.current, sessionIdRef.current));
                }
              }}
              disabled={busy || newBranchOpen}
            >
              {branches?.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant={newBranchOpen ? "primary" : "secondary"}
              disabled={busy}
              onClick={() => {
                if (newBranchOpen) {
                  setNewBranchOpen(false);
                } else {
                  setNewBranchName("");
                  setNewBranchOpen(true);
                }
              }}
              title={t("git.newBranch")}
            >
              <GitMerge size={13} />
            </Button>
          </div>

          {/* New branch input — full-width row so it stays usable in the narrow panel */}
          {newBranchOpen && (
            <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1.5">
              <Input
                autoFocus
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newBranchName.trim()) {
                    void runOp("newBranch", () => git.newBranch(cwdRef.current, newBranchName.trim(), distroRef.current, sessionIdRef.current)).then((ok) => {
                      if (ok) setNewBranchOpen(false);
                    });
                  } else if (e.key === "Escape") {
                    setNewBranchOpen(false);
                  }
                }}
                placeholder={t("git.newBranchPlaceholder")}
                className="h-8 flex-1 px-2 text-[12px]"
              />
              <Button
                size="sm"
                variant="primary"
                disabled={!newBranchName.trim() || busy}
                onClick={() =>
                  void runOp("newBranch", () => git.newBranch(cwdRef.current, newBranchName.trim(), distroRef.current, sessionIdRef.current)).then((ok) => {
                    if (ok) setNewBranchOpen(false);
                  })
                }
              >
                {t("git.create")}
              </Button>
              <SideIconButton label={t("git.close")} onClick={() => setNewBranchOpen(false)} icon={<X size={14} />} />
            </div>
          )}

          {/* Commit box */}
          <div className="shrink-0 border-b border-border px-2 py-2">
            <Textarea
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder={t("git.commitMsgPlaceholder")}
              rows={3}
              className="w-full resize-none px-2 py-1 text-[12px]"
            />
            <div className="mt-1.5 flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-subtle">
                <input
                  type="checkbox"
                  checked={amend}
                  onChange={(e) => setAmend(e.target.checked)}
                  className="accent-accent"
                />
                {t("git.amend")}
              </label>
              <Button
                size="sm"
                variant="primary"
                disabled={!commitMsg.trim() || busy}
                onClick={() =>
                  void runOp("commit", () => git.commit(cwdRef.current, commitMsg, amend, distroRef.current, sessionIdRef.current)).then(() =>
                    setCommitMsg(""),
                  )
                }
              >
                <GitCommit size={13} />
                {t("git.commit")}
              </Button>
            </div>
          </div>

          {/* File status list */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* The directory git is actually queried against. Surfaced so a
                stale/empty path (the classic "always clean" symptom) is visible
                instead of silently reporting a clean tree. */}
            <p
              className="border-b border-border/60 px-3 py-1 text-[10px] text-subtle"
              title={cwdRef.current}
            >
              {cwdRef.current}
            </p>
            {opResult && (
              <p className="border-b border-border bg-accent/5 px-3 py-1.5 text-[11px] text-accent">
                {opResult}
              </p>
            )}
            <FileGroup
              title={t("git.staged")}
              empty={t("git.none")}
              entries={staged}
              action="unstage"
              onAction={(paths) => void runOp("unstage", () => git.unstage(cwdRef.current, paths, distroRef.current, sessionIdRef.current))}
              onOpen={(e) => void openDiff(e)}
            />
            <FileGroup
              title={t("git.unstaged")}
              empty={t("git.clean")}
              entries={unstaged}
              action="stage"
              onAction={(paths) => void runOp("stage", () => git.stage(cwdRef.current, paths, distroRef.current, sessionIdRef.current))}
              onOpen={(e) => void openDiff(e)}
            />
            {staged.length === 0 && unstaged.length === 0 && (
              <p className="p-4 text-center text-[12px] text-subtle">{t("git.clean")}</p>
            )}
          </div>
        </div>
      )}

      <Dialog
        open={diffFile !== null}
        onClose={() => setDiffFile(null)}
        width="max-w-3xl"
        title={diffFile?.path ?? ""}
        description={
          diffFile
            ? diffFile.untracked
              ? t("git.diffUntracked")
              : diffFile.staged
                ? t("git.diffStaged")
                : t("git.diffUnstaged")
            : undefined
        }
        footer={
          diffFile && (
            <>
              {diffFile.staged ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void runOp("unstage", () => git.unstage(cwdRef.current, [diffFile.path], distroRef.current, sessionIdRef.current)).then(() =>
                      setDiffFile(null),
                    )
                  }
                >
                  <Minus size={13} />
                  {t("git.unstage")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void runOp("stage", () => git.stage(cwdRef.current, [diffFile.path], distroRef.current, sessionIdRef.current)).then(() =>
                      setDiffFile(null),
                    )
                  }
                >
                  <Plus size={13} />
                  {t("git.stage")}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setDiffFile(null)}>
                {t("git.close")}
              </Button>
            </>
          )
        }
      >
        {diffLoading ? (
          <div className="flex items-center gap-2 py-8 text-[12px] text-subtle">
            <Loader2 size={16} className="animate-spin" />
            {t("git.diffLoading")}
          </div>
        ) : diffError ? (
          <p className="whitespace-pre-wrap break-words py-4 text-[11px] text-danger">{diffError}</p>
        ) : diffBinary ? (
          <p className="py-4 text-center text-[12px] text-subtle">{t("git.binary")}</p>
        ) : diffText.trim().length === 0 ? (
          <p className="py-4 text-center text-[12px] text-subtle">{t("git.diffEmpty")}</p>
        ) : (
          <pre className="max-h-[55vh] overflow-auto rounded-lg border border-border bg-bg py-2 font-mono text-[11px] leading-[1.5]">
            {diffText.split("\n").map((line, i) => {
              const cls = line.startsWith("+")
                ? "bg-green-500/15 text-green-400"
                : line.startsWith("-")
                  ? "bg-red-500/15 text-red-400"
                  : line.startsWith("@@")
                    ? "text-accent/80"
                    : "text-fg";
              return (
                <div key={i} className={cn("whitespace-pre px-3", cls)}>
                  {line || " "}
                </div>
              );
            })}
          </pre>
        )}
      </Dialog>

      <Dialog
        open={logOpen}
        onClose={() => setLogOpen(false)}
        width="max-w-2xl"
        title={t("git.logTitle")}
        description={logDetail ? `${logDetail.shortHash} · ${logDetail.author} · ${logDetail.date}` : undefined}
        footer={
          logDetail ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => setResetOpen(true)}
                title={t("git.resetTitle")}
              >
                {t("git.reset")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void runOp("checkout", () => git.checkoutCommit(cwdRef.current, logDetail.hash, distroRef.current, sessionIdRef.current)).then(() => {
                    setLogOpen(false);
                  })
                }
                title={t("git.checkoutCommitHint")}
              >
                {t("git.checkoutCommit")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLogDetail(null)}>
                {t("git.log")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void navigator.clipboard.writeText(logDetail.hash).catch(() => {})}
                title={t("git.copyHash")}
              >
                {t("git.copyHash")}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setLogOpen(false)}>
              {t("git.close")}
            </Button>
          )
        }
      >
        {logDetail ? (
          logDetailLoading ? (
            <div className="flex items-center gap-2 py-8 text-[12px] text-subtle">
              <Loader2 size={16} className="animate-spin" />
              {t("git.diffLoading")}
            </div>
          ) : logDetailError ? (
            <p className="whitespace-pre-wrap break-words py-4 text-[11px] text-danger">{logDetailError}</p>
          ) : logDetailBinary ? (
            <p className="py-4 text-center text-[12px] text-subtle">{t("git.binary")}</p>
          ) : logDetailText.trim().length === 0 ? (
            <p className="py-4 text-center text-[12px] text-subtle">{t("git.diffEmpty")}</p>
          ) : (
            <pre className="max-h-[55vh] overflow-auto rounded-lg border border-border bg-bg py-2 font-mono text-[11px] leading-[1.5]">
              {logDetailText.split("\n").map((line, i) => {
                const cls = line.startsWith("+")
                  ? "bg-green-500/15 text-green-400"
                  : line.startsWith("-")
                    ? "bg-red-500/15 text-red-400"
                    : line.startsWith("@@")
                      ? "text-accent/80"
                      : "text-fg";
                return (
                  <div key={i} className={cn("whitespace-pre px-3", cls)}>
                    {line || " "}
                  </div>
                );
              })}
            </pre>
          )
        ) : logLoading ? (
          <div className="flex items-center gap-2 py-8 text-[12px] text-subtle">
            <Loader2 size={16} className="animate-spin" />
            {t("git.logLoading")}
          </div>
        ) : logError ? (
          <p className="whitespace-pre-wrap break-words py-4 text-[11px] text-danger">{logError}</p>
        ) : logCommits.length === 0 ? (
          <p className="py-4 text-center text-[12px] text-subtle">{t("git.logEmpty")}</p>
        ) : (
          <div className="max-h-[55vh] overflow-auto">
            {logCommits.map((c) => (
              <button
                key={c.hash}
                className="block w-full border-b border-border/50 px-3 py-2 text-left hover:bg-hover"
                onClick={() => void openCommitDetail(c)}
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 font-mono text-[11px] text-accent">{c.shortHash}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{c.subject}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-subtle">
                  <span className="truncate">{c.author}</span>
                  <span>·</span>
                  <span className="shrink-0">{c.date}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Dialog>

      <Dialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        width="max-w-sm"
        title={t("git.resetTitle")}
        description={logDetail ? `${logDetail.shortHash} · ${logDetail.subject}` : undefined}
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setResetOpen(false)}>
              {t("git.close")}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[11px] text-subtle">{t("git.resetHint")}</p>
        <div className="flex flex-col gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !logDetail}
            onClick={() =>
              void runOp("reset", () => git.reset(cwdRef.current, "soft", logDetail!.hash, distroRef.current, sessionIdRef.current)).then(() => {
                setResetOpen(false);
                setLogOpen(false);
              })
            }
          >
            {t("git.resetSoft")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !logDetail}
            onClick={() =>
              void runOp("reset", () => git.reset(cwdRef.current, "mixed", logDetail!.hash, distroRef.current, sessionIdRef.current)).then(() => {
                setResetOpen(false);
                setLogOpen(false);
              })
            }
          >
            {t("git.resetMixed")}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy || !logDetail}
            onClick={() =>
              void runOp("reset", () => git.reset(cwdRef.current, "hard", logDetail!.hash, distroRef.current, sessionIdRef.current)).then(() => {
                setResetOpen(false);
                setLogOpen(false);
              })
            }
          >
            {t("git.resetHard")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function FileGroup({
  title,
  empty,
  entries,
  action,
  onAction,
  onOpen,
}: {
  title: string;
  empty: string;
  entries: GitFileEntry[];
  action: "stage" | "unstage";
  onAction: (paths: string[]) => void;
  onOpen: (entry: GitFileEntry) => void;
}) {
  const t = useT();
  if (entries.length === 0) return null;
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center justify-between bg-surface px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">
        <span>{title}</span>
        <span className="text-subtle/70">{entries.length}</span>
      </div>
      {entries.map((e) => (
        <div
          key={e.path}
          className="group flex items-center gap-2 border-b border-border/50 px-2 py-1 hover:bg-hover"
        >
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            onClick={() => onOpen(e)}
            title={t("git.viewDiff")}
          >
            <StatusBadge entry={e} />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg" title={e.path}>
              {e.path}
            </span>
          </button>
          <button
            className="shrink-0 rounded p-1 text-muted opacity-0 hover:bg-bg hover:text-accent group-hover:opacity-100"
            title={t("git.viewDiff")}
            onClick={() => onOpen(e)}
          >
            <Eye size={13} />
          </button>
          <button
            className="shrink-0 rounded p-1 text-muted hover:bg-bg hover:text-accent"
            title={action === "stage" ? "Stage" : "Unstage"}
            onClick={() => onAction([e.path])}
          >
            {action === "stage" ? <Plus size={13} /> : <Minus size={13} />}
          </button>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ entry }: { entry: GitFileEntry }) {
  const code = entry.untracked ? "?" : entry.staged ? entry.x : entry.y;
  const color =
    code === "A"
      ? "bg-green-500/20 text-green-500"
      : code === "M"
        ? "bg-amber-500/20 text-amber-500"
        : code === "D"
          ? "bg-red-500/20 text-red-500"
          : code === "R"
            ? "bg-purple-500/20 text-purple-500"
            : code === "U"
              ? "bg-orange-500/20 text-orange-500"
              : code === "?"
                ? "bg-blue-500/20 text-blue-500"
                : "bg-subtle/20 text-subtle";
  return (
    <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold", color)}>
      {code}
    </span>
  );
}
