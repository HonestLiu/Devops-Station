import { forwardRef, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Boxes,
  Container as ContainerIcon,
  Download,
  ExternalLink,
  Logs,
  Play,
  RefreshCw,
  Square,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";

import { Button, SideIconButton, Badge, Dialog, Input, Textarea, EmptyState, Field, Checkbox } from "@/components/ui";
import { useT, type TKey } from "@/i18n";
import { docker, localFs } from "@/lib/api";
import type { DockerContainer, DockerImage, DockerRunOptions } from "@/lib/types";

type Tab = "containers" | "images" | "compose";

function stateTone(state: string): "success" | "neutral" | "warning" | "danger" {
  switch (state.toLowerCase()) {
    case "running":
      return "success";
    case "paused":
      return "warning";
    case "exited":
    case "dead":
    case "created":
      return "neutral";
    default:
      return "danger";
  }
}

const STATE_KEYS: Record<string, TKey> = {
  running: "docker.state.running",
  exited: "docker.state.exited",
  paused: "docker.state.paused",
  created: "docker.state.created",
};

function stateLabel(t: (k: TKey, p?: Record<string, string | number>) => string, state: string): string {
  const key = STATE_KEYS[state.toLowerCase()];
  return key ? t(key) : state;
}

/** A single port entry, parsed from `docker ps` output. */
interface ParsedPort {
  /** Host bind address, e.g. "0.0.0.0" or "::". Empty when not published. */
  host: string;
  /** Host port as published, e.g. "8080". Empty when not published. */
  hostPort: string;
  /** Container port, e.g. "80". */
  containerPort: string;
  /** Protocol, e.g. "tcp" or "udp". */
  proto: string;
  /** Whether this port is published to the host (has a host:port mapping). */
  published: boolean;
  /** Full URL to open, e.g. "http://localhost:8080". Empty when not published. */
  url: string;
}

/**
 * Parse the raw `ports` string from `docker ps` into structured entries.
 * Handles both published mappings (`0.0.0.0:8080->80/tcp`,
 * `:::8080->80/tcp`) and exposed-only entries (`80/tcp`). The `::` (IPv6
 * any) and `0.0.0.0` binds both map to `localhost` since that's reachable.
 */
/**
 * Parse the raw `ports` string from `docker ps` into structured entries.
 * Any mapping that exposes a *host* port (`xxx:yyy`, with or without a
 * `->` separator, with or without a `/tcp`/`/udp` suffix, and with support
 * for port *ranges* like `9000-9001->9000-9001/tcp`) is treated as a
 * published, clickable Web port. Only bare `containerPort/proto` entries
 * (no host binding) are marked not-published.
 */
function parsePorts(raw: string | undefined): ParsedPort[] {
  if (!raw) return [];
  const out: ParsedPort[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;

    // Expand "lo-hi" into the list of individual ports (single port -> [n]).
    const expand = (r: string): number[] => {
      const m = r.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return [];
      const lo = parseInt(m[1], 10);
      const hi = m[2] ? parseInt(m[2], 10) : lo;
      const xs: number[] = [];
      for (let p = lo; p <= hi; p++) xs.push(p);
      return xs;
    };

    // Published with "->": [host:]hostRange -> containerRange[/proto]
    const arrow = s.match(/^(?:([\w.:]+):)?(\d+(?:-\d+)?)\s*->\s*(\d+(?:-\d+)?)(?:\/(tcp|udp))?$/i);
    if (arrow) {
      const bind = arrow[1] ?? "0.0.0.0";
      const hosts = expand(arrow[2]);
      const containers = expand(arrow[3]);
      const proto = (arrow[4] ?? "tcp").toLowerCase();
      const scheme = proto === "udp" ? "udp" : "http";
      const host = bind === "::" || bind === "0.0.0.0" ? "localhost" : bind;
      const n = Math.max(hosts.length, containers.length);
      for (let i = 0; i < n; i++) {
        const hp = hosts[i] ?? hosts[0];
        const cp = containers[i] ?? containers[0];
        out.push({
          host: bind,
          hostPort: String(hp),
          containerPort: String(cp),
          proto,
          published: true,
          url: `${scheme}://${host}:${hp}`,
        });
      }
      continue;
    }
    // Published without "->": hostRange:containerRange[/proto]
    // (e.g. `9000:39000/tcp` or plain `9000:39000`).
    const colon = s.match(/^(\d+(?:-\d+)?):(\d+(?:-\d+)?)(?:\/(tcp|udp))?$/i);
    if (colon) {
      const hosts = expand(colon[1]);
      const containers = expand(colon[2]);
      const proto = (colon[3] ?? "tcp").toLowerCase();
      const scheme = proto === "udp" ? "udp" : "http";
      const n = Math.max(hosts.length, containers.length);
      for (let i = 0; i < n; i++) {
        const hp = hosts[i] ?? hosts[0];
        const cp = containers[i] ?? containers[0];
        out.push({
          host: "localhost",
          hostPort: String(hp),
          containerPort: String(cp),
          proto,
          published: true,
          url: `${scheme}://localhost:${hp}`,
        });
      }
      continue;
    }
    // Exposed-only: containerRange[/proto] (no host binding) — not clickable.
    const exp = s.match(/^(\d+(?:-\d+)?)(?:\/(tcp|udp))?$/i);
    if (exp) {
      const ports = expand(exp[1]);
      const proto = (exp[2] ?? "tcp").toLowerCase();
      for (const cp of ports) {
        out.push({
          host: "",
          hostPort: "",
          containerPort: String(cp),
          proto,
          published: false,
          url: "",
        });
      }
    }
  }
  return out;
}

export function DockerPanel({
  distro,
  sessionId,
  onClose,
}: {
  distro?: string;
  sessionId?: string;
  onClose: () => void;
}) {
  const t = useT();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("containers");
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [images, setImages] = useState<DockerImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Logs dialog state.
  const [logTarget, setLogTarget] = useState<DockerContainer | null>(null);
  const [logText, setLogText] = useState("");
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | undefined>();

  /** Container id whose port list popover is open, or null. */
  const [portMenu, setPortMenu] = useState<string | null>(null);

  // Run-container dialog state.
  const [runOpen, setRunOpen] = useState(false);
  const [runImage, setRunImage] = useState("");
  const [runName, setRunName] = useState("");
  const [runPorts, setRunPorts] = useState("");
  const [runEnvs, setRunEnvs] = useState("");
  const [runCmd, setRunCmd] = useState("");
  const [runDetach, setRunDetach] = useState(true);
  const [runRm, setRunRm] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [runResult, setRunResult] = useState<string | undefined>();
  const [runError, setRunError] = useState<string | undefined>();

  // Pull dialog state.
  const [pullOpen, setPullOpen] = useState(false);
  const [pullName, setPullName] = useState("");
  const [pullBusy, setPullBusy] = useState(false);
  const [pullError, setPullError] = useState<string | undefined>();

  // Remove confirmation.
  const [confirm, setConfirm] = useState<{ kind: "container" | "image"; name: string; id: string } | null>(null);

  // Compose state.
  const [composePath, setComposePath] = useState("");
  const [composeOutput, setComposeOutput] = useState("");
  const [composeLoading, setComposeLoading] = useState(false);

  const distroRef = useRef(distro);
  distroRef.current = distro;
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [cs, is] = await Promise.all([
        docker.ps(distroRef.current, sessionRef.current),
        docker.images(distroRef.current, sessionRef.current),
      ]);
      setContainers(cs);
      setImages(is);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ok = await docker.available(distroRef.current, sessionRef.current);
        if (cancelled) return;
        setAvailable(ok);
        if (ok) await load();
      } catch (e) {
        if (!cancelled) {
          setAvailable(false);
          setError((e as Error).message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  // --- Container actions --------------------------------------------------
  const act = useCallback(
    async (fn: () => Promise<unknown>, after?: () => void) => {
      setBusy(true);
      setError(undefined);
      try {
        await fn();
        after?.();
        await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const openLogs = useCallback(async (c: DockerContainer) => {
    setLogTarget(c);
    setLogText("");
    setLogError(undefined);
    setLogLoading(true);
    try {
      const text = await docker.logs(c.id, 500, distroRef.current, sessionRef.current);
      setLogText(text);
    } catch (e) {
      setLogError((e as Error).message);
    } finally {
      setLogLoading(false);
    }
  }, []);

  // --- Run form -----------------------------------------------------------
  const submitRun = useCallback(async () => {
    if (!runImage.trim()) {
      setRunError(t("docker.error", { msg: t("docker.runImagePlaceholder") }));
      return;
    }
    const opts: DockerRunOptions = {
      image: runImage.trim(),
      name: runName.trim() || undefined,
      ports: runPorts.split("\n").map((s) => s.trim()).filter(Boolean),
      envs: runEnvs.split("\n").map((s) => s.trim()).filter(Boolean),
      cmd: runCmd.trim() || undefined,
      detach: runDetach,
      rm: runRm,
    };
    setRunBusy(true);
    setRunError(undefined);
    setRunResult(undefined);
    try {
      const id = await docker.run(opts, distroRef.current, sessionRef.current);
      setRunResult(t("docker.runDone", { id }));
      setRunImage("");
      setRunName("");
      setRunPorts("");
      setRunEnvs("");
      setRunCmd("");
      await load();
    } catch (e) {
      setRunError((e as Error).message);
    } finally {
      setRunBusy(false);
    }
  }, [runImage, runName, runPorts, runEnvs, runCmd, runDetach, runRm, t, load]);

  // --- Pull ----------------------------------------------------------------
  const submitPull = useCallback(async () => {
    if (!pullName.trim()) {
      setPullError(t("docker.pullPlaceholder"));
      return;
    }
    setPullBusy(true);
    setPullError(undefined);
    try {
      await docker.pull(pullName.trim(), distroRef.current, sessionRef.current);
      setPullName("");
      setPullOpen(false);
      await load();
    } catch (e) {
      setPullError((e as Error).message);
    } finally {
      setPullBusy(false);
    }
  }, [pullName, t, load]);

  // --- Compose --------------------------------------------------------------
  const runCompose = useCallback(
    async (action: string) => {
      if (!composePath.trim()) {
        setComposeOutput("");
        setError(t("docker.error", { msg: t("docker.composePath") }));
        return;
      }
      setComposeLoading(true);
      setComposeOutput("");
      setError(undefined);
      try {
        const out = await docker.compose(composePath.trim(), action, distroRef.current, sessionRef.current);
        setComposeOutput(out.trim() || t("docker.done"));
      } catch (e) {
        setComposeOutput((e as Error).message);
      } finally {
        setComposeLoading(false);
      }
    },
    [composePath, t],
  );

  // --- Render --------------------------------------------------------------
  if (available === false && !logTarget) {
    return (
      <div className="relative flex h-full w-[400px] shrink-0 flex-col border-l border-border bg-surface">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
          <span className="icon-chip flex h-6 w-6 shrink-0 items-center justify-center">
            <ContainerIcon size={13} />
          </span>
          <span className="flex-1 truncate text-[12px] font-semibold text-fg">{t("docker.title")}</span>
          <SideIconButton label={t("docker.refresh")} onClick={() => void (async () => {
            const ok = await docker.available(distroRef.current, sessionRef.current);
            setAvailable(ok);
            if (ok) await load();
          })()} icon={<RefreshCw size={14} />} />
          <SideIconButton label={t("git.close")} onClick={onClose} icon={<X size={14} />} />
        </div>
        <EmptyState icon={<ContainerIcon size={28} />} title={t("docker.title")} description={t("docker.notAvailable")} />
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-[400px] shrink-0 flex-col border-l border-border bg-surface">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <span className="icon-chip flex h-6 w-6 shrink-0 items-center justify-center">
          <ContainerIcon size={13} />
        </span>
        <span className="flex-1 truncate text-[12px] font-semibold text-fg">{t("docker.title")}</span>
        <SideIconButton label={t("docker.refresh")} onClick={refresh} icon={<RefreshCw size={14} />} disabled={loading} />
        <SideIconButton label={t("git.close")} onClick={onClose} icon={<X size={14} />} />
      </div>

      {/* Tabs */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        {(
          [
            ["containers", t("docker.tabContainers")],
            ["images", t("docker.tabImages")],
            ["compose", t("docker.tabCompose")],
          ] as [Tab, string][]
        ).map(([tk, label]) => (
          <button
            key={tk}
            type="button"
            onClick={() => setTab(tk)}
            className={
              "rounded-md px-2 py-1 text-[12px] font-medium transition-colors " +
              (tab === tk ? "bg-accent/15 text-accent" : "text-muted hover:bg-hover hover:text-fg")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          <span className="flex-1 break-words">{t("docker.error", { msg: error })}</span>
          <button type="button" onClick={() => setError(undefined)} className="shrink-0 text-danger/70 hover:text-danger">
            <X size={12} />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {available === null ? (
          <div className="flex items-center justify-center py-8 text-[12px] text-subtle">{t("docker.loading")}</div>
        ) : tab === "containers" ? (
          containers.length === 0 ? (
            <EmptyState icon={<Boxes size={26} />} title={t("docker.containersEmpty")} />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {containers.map((c) => (
                <li key={c.id} className="rounded-lg border border-border bg-bg p-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg" title={c.names}>
                      {c.names || c.id}
                    </span>
                    <Badge tone={stateTone(c.state)}>{stateLabel(t, c.state || c.status)}</Badge>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-subtle" title={c.image}>
                    {c.image}
                  </div>
                  {c.ports && (
                    <div className="mt-0.5 truncate text-[11px] text-subtle" title={c.ports}>
                      {t("docker.ports")}: {c.ports}
                    </div>
                  )}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {c.state.toLowerCase() === "running" ? (
                      <IconBtn label={t("docker.stop")} onClick={() => void act(() => docker.stop(c.id, distroRef.current, sessionRef.current))} icon={<Square size={12} />} />
                    ) : (
                      <IconBtn label={t("docker.start")} onClick={() => void act(() => docker.start(c.id, distroRef.current, sessionRef.current))} icon={<Play size={12} />} />
                    )}
                    <IconBtn label={t("docker.restart")} onClick={() => void act(() => docker.restart(c.id, distroRef.current, sessionRef.current))} icon={<RotateCw size={12} />} />
                    <IconBtn label={t("docker.logs")} onClick={() => void openLogs(c)} icon={<Logs size={12} />} />
                    {(() => {
                      const ports = parsePorts(c.ports);
                      if (ports.length === 0) return null;
                      const published = ports.filter((p) => p.published);
                      // Single published port: open directly.
                      if (published.length === 1) {
                        return (
                          <IconBtn
                            label={t("docker.openUrl", { port: published[0].hostPort })}
                            onClick={() => void localFs.openUrl(published[0].url)}
                            icon={<ExternalLink size={12} />}
                          />
                        );
                      }
                      // Multiple/zero published: show a popover listing ALL ports.
                      return <PortMenu ports={ports} open={portMenu === c.id} onToggle={() => setPortMenu(portMenu === c.id ? null : c.id)} onClose={() => setPortMenu(null)} t={t} />;
                    })()}
                    <IconBtn label={t("docker.remove")} danger onClick={() => setConfirm({ kind: "container", name: c.names || c.id, id: c.id })} icon={<Trash2 size={12} />} />
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : tab === "images" ? (
          <div className="flex flex-col gap-2">
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => { setPullName(""); setPullError(undefined); setPullOpen(true); }}>
                <Download size={13} />
                {t("docker.pull")}
              </Button>
            </div>
            {images.length === 0 ? (
              <EmptyState icon={<Boxes size={26} />} title={t("docker.imagesEmpty")} />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {images.map((img) => (
                  <li key={img.id} className="flex items-center gap-2 rounded-lg border border-border bg-bg p-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-fg" title={`${img.repo}:${img.tag}`}>
                        {img.repo}:{img.tag}
                      </div>
                      <div className="truncate text-[11px] text-subtle" title={img.id}>
                        {img.id} · {img.size}
                      </div>
                    </div>
                    <IconBtn label={t("docker.remove")} danger onClick={() => setConfirm({ kind: "image", name: `${img.repo}:${img.tag}`, id: img.id })} icon={<Trash2 size={12} />} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label={t("docker.composePath")}>
              <Input
                value={composePath}
                onChange={(e) => setComposePath(e.target.value)}
                placeholder={t("docker.composePathPlaceholder")}
              />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="primary" disabled={composeLoading} onClick={() => void runCompose("up")}>{t("docker.composeUp")}</Button>
              <Button size="sm" variant="secondary" disabled={composeLoading} onClick={() => void runCompose("down")}>{t("docker.composeDown")}</Button>
              <Button size="sm" variant="secondary" disabled={composeLoading} onClick={() => void runCompose("ps")}>{t("docker.composePs")}</Button>
              <Button size="sm" variant="secondary" disabled={composeLoading} onClick={() => void runCompose("restart")}>{t("docker.composeRestart")}</Button>
            </div>
            {composeLoading && <div className="text-[12px] text-subtle">{t("docker.composeRunning")}</div>}
            {composeOutput && (
              <Textarea readOnly value={composeOutput} className="h-48 text-[12px]" />
            )}
          </div>
        )}
      </div>

      {/* Run container button (only on containers tab) */}
      {tab === "containers" && (
        <div className="shrink-0 border-t border-border p-2">
          <Button size="sm" variant="primary" className="w-full" onClick={() => { setRunResult(undefined); setRunError(undefined); setRunOpen(true); }}>
            <Play size={13} />
            {t("docker.run")}
          </Button>
        </div>
      )}

      {/* Logs dialog */}
      <Dialog
        open={!!logTarget}
        onClose={() => setLogTarget(null)}
        title={t("docker.logsTitle")}
        width="max-w-2xl"
      >
        {logLoading ? (
          <div className="py-8 text-center text-[12px] text-subtle">{t("docker.logsLoading")}</div>
        ) : logError ? (
          <p className="whitespace-pre-wrap break-words text-[12px] text-danger">{logError}</p>
        ) : (
          <Textarea readOnly value={logText} className="h-96 text-[12px]" />
        )}
      </Dialog>

      {/* Run dialog */}
      <Dialog
        open={runOpen}
        onClose={() => setRunOpen(false)}
        title={t("docker.runTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRunOpen(false)}>{t("git.close")}</Button>
            <Button variant="primary" disabled={runBusy} onClick={() => void submitRun()}>
              {runBusy ? t("docker.runRunning") : t("docker.runSubmit")}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label={t("docker.runImage")}>
            <Input value={runImage} onChange={(e) => setRunImage(e.target.value)} placeholder={t("docker.runImagePlaceholder")} />
          </Field>
          <Field label={t("docker.runName")}>
            <Input value={runName} onChange={(e) => setRunName(e.target.value)} />
          </Field>
          <Field label={t("docker.runPorts")}>
            <Textarea value={runPorts} onChange={(e) => setRunPorts(e.target.value)} className="h-20 text-[12px]" />
          </Field>
          <Field label={t("docker.runEnvs")}>
            <Textarea value={runEnvs} onChange={(e) => setRunEnvs(e.target.value)} className="h-20 text-[12px]" />
          </Field>
          <Field label={t("docker.runCommand")}>
            <Input value={runCmd} onChange={(e) => setRunCmd(e.target.value)} />
          </Field>
          <div className="flex gap-4">
            <Checkbox checked={runDetach} onChange={setRunDetach} label={t("docker.runDetach")} />
            <Checkbox checked={runRm} onChange={setRunRm} label={t("docker.runAutoRemove")} />
          </div>
          {runError && <p className="whitespace-pre-wrap break-words text-[11px] text-danger">{runError}</p>}
          {runResult && <p className="text-[11px] text-success">{runResult}</p>}
        </div>
      </Dialog>

      {/* Pull dialog */}
      <Dialog
        open={pullOpen}
        onClose={() => setPullOpen(false)}
        title={t("docker.pull")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPullOpen(false)}>{t("git.close")}</Button>
            <Button variant="primary" disabled={pullBusy} onClick={() => void submitPull()}>
              {pullBusy ? t("docker.pulling") : t("docker.pull")}
            </Button>
          </>
        }
      >
        <Field label={t("docker.pull")}>
          <Input value={pullName} onChange={(e) => setPullName(e.target.value)} placeholder={t("docker.pullPlaceholder")} />
        </Field>
        {pullError && <p className="whitespace-pre-wrap break-words text-[11px] text-danger">{pullError}</p>}
      </Dialog>

      {/* Remove confirmation */}
      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "image" ? t("docker.remove") : t("docker.remove")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>{t("git.close")}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const c = confirm;
                if (!c) return;
                setConfirm(null);
                if (c.kind === "container") {
                  void act(() => docker.remove(c.id, true, distroRef.current, sessionRef.current));
                } else {
                  void act(() => docker.rmi(c.id, true, distroRef.current, sessionRef.current));
                }
              }}
            >
              {t("docker.remove")}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-fg">
          {confirm?.kind === "image"
            ? t("docker.confirmRemoveImage", { name: confirm?.name ?? "" })
            : t("docker.confirmRemoveContainer", { name: confirm?.name ?? "" })}
        </p>
      </Dialog>
    </div>
  );
}

/**
 * "Open URL" trigger + port list for containers with multiple/zero published
 * ports. The menu is `position: fixed` and anchored to the button's bounding
 * rect, so it escapes the panel's `overflow-y-auto` clipping and is never
 * hidden behind the left sidebar.
 */
function PortMenu({
  ports,
  open,
  onToggle,
  onClose,
  t,
}: {
  ports: ParsedPort[];
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  t: (key: TKey, params?: Record<string, string | number>) => string;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rect = triggerRef.current?.getBoundingClientRect();
  const menuStyle: CSSProperties | undefined = rect
    ? {
        position: "fixed",
        top: rect.bottom + 4,
        left: rect.left, // expand to the right of the button
        zIndex: 60,
      }
    : undefined;
  return (
    <>
      <IconBtn
        ref={triggerRef}
        label={t("docker.openUrlMenu")}
        onClick={onToggle}
        icon={<ExternalLink size={12} />}
      />
      {open && rect && (
        <>
          <div className="fixed inset-0 z-50" onClick={onClose} />
          <div
            style={menuStyle}
            className="w-52 overflow-hidden rounded-md border border-border bg-bg py-1 shadow-xl"
          >
            {ports.map((p, i) => (
              <button
                key={`${p.containerPort}-${i}`}
                type="button"
                disabled={!p.published}
                title={p.published ? p.url : t("docker.portNotPublished")}
                onClick={() => {
                  if (!p.published) return;
                  void localFs.openUrl(p.url);
                  onClose();
                }}
                className={
                  "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[12px] " +
                  (p.published ? "text-fg hover:bg-hover" : "cursor-not-allowed text-subtle")
                }
              >
                <ExternalLink size={12} className={"shrink-0 " + (p.published ? "text-accent" : "text-subtle")} />
                <span className="truncate">
                  {p.published
                    ? `${p.hostPort} → ${p.containerPort}/${p.proto}`
                    : `${p.containerPort}/${p.proto} (${t("docker.portNotPublished")})`}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Small icon-only action button used in card rows. */
const IconBtn = forwardRef<HTMLButtonElement, {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
}>(function IconBtn({ label, icon, onClick, danger }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={
        "inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-muted transition-colors hover:bg-hover " +
        (danger ? "hover:text-danger" : "hover:text-fg")
      }
    >
      {icon}
    </button>
  );
});
