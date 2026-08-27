import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Loader2, Plug, Power, Unplug, XCircle } from "lucide-react";

import { Badge, Button } from "@/components/ui";
import { useT } from "@/i18n";
import { useJlinkStore } from "@/store/useJlinkStore";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for every J-Link surface (picker page + the three
 * module workspaces). Extracted so Flash / RTT / GDB and the picker all render
 * the same chrome: the module header strip, section cards, output console and
 * the not-installed banner — one visual family instead of four layouts.
 */

/**
 * Full-width warning band pinned under the module header when the SEGGER
 * J-Link software is missing. Shown only while not installed — the header
 * itself stays clean of availability noise. Mirrors the MQTT connection-error
 * strip.
 */
export function JLinkInstallBanner() {
  const t = useT();
  const available = useJlinkStore((s) => s.available);
  if (available !== false) return null;
  return (
    <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-[12px] text-warning">
      <AlertTriangle size={13} className="shrink-0" />
      <span>{t("jlink.notFound")}</span>
    </div>
  );
}

/** One section card: optional title bar (title + right slot) over padded body. */
export function JLinkCard({
  title,
  icon,
  right,
  children,
  className,
}: {
  title?: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-surface", className)}>
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
          <h2 className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-subtle">
            {icon}
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className="flex flex-col gap-3 p-4">{children}</div>
    </section>
  );
}

/**
 * The shared operation/log console: a titled bar over a monospace, auto-scrolling
 * `<pre>`. Used full-width under the Flash cards and the GDB server card so both
 * modules read the same. The header carries a Copy button (whole-buffer copy)
 * so users can grab the full JLinkCommander / GDB server log without manually
 * selecting and Ctrl+C-ing the auto-scrolling `<pre>`.
 */
export function JLinkConsole({
  title,
  right,
  value,
  placeholder,
  height = "h-64",
}: {
  title: string;
  right?: ReactNode;
  value: string;
  placeholder: string;
  height?: string;
}) {
  const t = useT();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [value]);

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard may be blocked in some envs — swallow rather than noisy-fail */
    }
  };

  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">{title}</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            disabled={!value}
            title={copied ? t("common.copied") : t("common.copy")}
            aria-label={t("common.copy")}
            className={cn(
              "flex h-6 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium transition-colors",
              copied
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-border/70 bg-bg/40 text-subtle hover:border-border hover:bg-hover hover:text-fg",
              !value && "cursor-not-allowed opacity-40 hover:bg-bg/40 hover:text-subtle",
            )}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t("common.copied") : t("common.copy")}
          </button>
          {right}
        </div>
      </header>
      <pre
        ref={ref}
        className={cn(
          "overflow-auto p-3 font-mono text-[11px] leading-relaxed text-muted",
          height,
        )}
      >
        {value || placeholder}
      </pre>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Richer status / result chrome — replaces the old "log dump" with a header
// badge + per-operation result card so the user always knows what state the
// probe is in and what the last action did, without having to scroll the log.
// ---------------------------------------------------------------------------

/**
 * Shape of the visual result the workspace feeds into `JLinkResultCard`.
 * `idle` covers the pre-first-op state, `loading` flips on while the op is
 * in flight, then settles into `ok` or `fail` with optional payload/detail.
 *
 * `payload` (string) and `payloadNode` (ReactNode) are mutually exclusive at
 * render time — `payloadNode` wins. Use the string form for simple text
 * results (file names, byte counts), and the node form for structured
 * visualizations (the read-mem hex dump).
 */
export type JLinkLastResult =
  | { state: "idle" }
  | { state: "loading"; title: string }
  | {
      state: "ok" | "fail";
      title: string;
      summary?: string;
      payload?: string;
      payloadNode?: ReactNode;
      detail?: string;
    };

/**
 * Top-of-workspace connection status bar. Shows a green/grey badge with the
 * target the user is connected to, and a Connect/Disconnect button that
 * reflects the cached status from the backend.
 *
 * Note: the probe itself is one-shot per script (Commander connects, runs
 * the body, disconnects, exits). The status here is a *cached* snapshot of
 * the last successful connect — clicking Disconnect doesn't tear down any
 * real session, it just clears the cache so the UI returns to the neutral
 * state. The comment on `JLinkStatus` in the Rust backend explains the
 * trade-off in more detail.
 */
export function JLinkStatusHeader({
  busy,
  onConnect,
  onDisconnect,
}: {
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const t = useT();
  const status = useJlinkStore((s) => s.status);
  const isConnected = status.device.trim().length > 0;

  const speedLabel = status.speed > 0 ? `${status.speed} kHz` : t("jlink.auto");
  const subline = isConnected
    ? t("jlink.connectedTo", { device: status.device, iface: status.iface, speed: speedLabel })
    : t("jlink.notConnected");

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5",
        isConnected ? "border-success/30 bg-success/5" : "border-border bg-surface",
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            isConnected ? "bg-success/15 text-success" : "bg-hover text-subtle",
          )}
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : isConnected ? (
            <Plug size={14} />
          ) : (
            <Unplug size={14} />
          )}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Badge tone={isConnected ? "success" : "neutral"}>
              {isConnected ? t("jlink.connect") : t("jlink.notConnected")}
            </Badge>
            {status.serial && <Badge tone="neutral">S/N {status.serial}</Badge>}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-subtle">{subline}</div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {isConnected ? (
          <Button variant="secondary" disabled={busy} onClick={onDisconnect}>
            <Unplug size={13} /> {t("jlink.disconnect")}
          </Button>
        ) : (
          <Button variant="primary" disabled={busy} onClick={onConnect}>
            <Power size={13} /> {t("jlink.connect")}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Visual result of the most recent J-Link operation. Renders an icon
 * (success/failure/loading), a title and one-line summary, and an optional
 * payload (hex bytes for read, address+bytes for write, etc.). Replaces the
 * old "scroll the log until you see the answer" UX.
 */
export function JLinkResultCard({ result }: { result: JLinkLastResult }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // `idle` shows a neutral "no op yet" card with no payload/detail.
  // `loading` / `ok` / `fail` share the result-card chrome.
  const state = result.state;
  const title = result.state === "idle" ? t("jlink.lastResult") : result.title;
  const summary =
    result.state === "idle"
      ? t("jlink.noResult")
      : result.state === "loading"
        ? undefined
        : result.summary;
  // payloadNode wins over the plain-text payload (used by the read-mem hex dump).
  const payloadNode =
    result.state === "ok" || result.state === "fail" ? result.payloadNode : undefined;
  const payload =
    payloadNode ? undefined : result.state === "ok" || result.state === "fail" ? result.payload : undefined;
  // The Copy button writes a flat hex string. When we have a visual hex dump
  // the caller hands us `payload` as a clean `AA BB CC …` line (see
  // JLinkFlashWorkspace's read-mem runOp), so the user can paste the bytes
  // straight into code. For other ops `payload` is whatever string the caller
  // set (a file name, byte count, etc.).
  const copyText = payload ?? "";
  const detail = result.state === "ok" || result.state === "fail" ? result.detail : undefined;

  const icon =
    state === "loading" ? (
      <Loader2 size={15} className="animate-spin text-accent" />
    ) : state === "ok" ? (
      <Check size={15} className="text-success" />
    ) : state === "fail" ? (
      <XCircle size={15} className="text-danger" />
    ) : (
      <Power size={15} className="text-subtle" />
    );

  const tone = state === "ok" ? "border-success/30" : state === "fail" ? "border-danger/30" : "border-border";
  const bg = state === "ok" ? "bg-success/5" : state === "fail" ? "bg-danger/5" : "bg-surface";

  const copyPayload = async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const showCopy = !!(payloadNode || payload);

  return (
    <div className={cn("rounded-xl border", tone, bg)}>
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 shrink-0">{icon}</span>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-fg">{title}</div>
            {summary && <div className="mt-0.5 truncate text-[11px] text-subtle">{summary}</div>}
          </div>
        </div>
        {showCopy && (
          <button
            type="button"
            onClick={copyPayload}
            disabled={!copyText}
            title={copied ? t("common.copied") : t("common.copy")}
            className={cn(
              "flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[11px] font-medium transition-colors",
              copied
                ? "border-accent/40 bg-accent/15 text-accent"
                : "border-border/70 bg-bg/40 text-subtle hover:border-border hover:bg-hover hover:text-fg",
              !copyText && "cursor-not-allowed opacity-40",
            )}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        )}
      </div>
      {payloadNode && <div className="px-4 pb-3">{payloadNode}</div>}
      {payload && (
        <pre className="mx-4 mb-3 max-h-32 overflow-auto rounded-md border border-border/50 bg-bg/60 p-2 font-mono text-[10.5px] leading-relaxed text-fg/80">
          {payload}
        </pre>
      )}
      {detail && (
        <div className="border-t border-border/40 px-4 py-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-[10.5px] text-subtle transition-colors hover:text-fg"
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {expanded ? t("jlink.collapseLog") : t("jlink.expandLog")}
          </button>
          {expanded && (
            <pre className="mt-2 max-h-40 overflow-auto font-mono text-[10px] leading-relaxed text-muted">
              {detail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hex dump — visual renderer for `jlink.readMem` output.
// ---------------------------------------------------------------------------

/**
 * Walk J-Link Commander's `mem <addr>, <len>` output and collect every
 * `<addr> = <byte byte …>` line. The driver can break the dump across
 * multiple lines (one per 16-byte row), so we stitch them into a single
 * byte buffer anchored at `addr` for the HexDump component to render.
 *
 * Returns `null` when no `<addr> = …` line is present — callers should
 * fall back to the raw text payload in that case.
 */
export function parseMemOutput(
  output: string,
  fallbackAddr: number,
): { addr: number; bytes: Uint8Array } | null {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[\dA-Fa-f]+\s*=\s*[0-9A-Fa-f]/.test(l));
  if (lines.length === 0) return null;

  const all: number[] = [];
  let base: number | null = null;
  for (const line of lines) {
    const eq = line.indexOf("=");
    const addrStr = line.slice(0, eq).trim();
    const bytesStr = line.slice(eq + 1).trim();
    const addr = Number.parseInt(addrStr, 16);
    if (Number.isNaN(addr)) continue;
    if (base === null) base = addr;
    const bytes = bytesStr
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((b) => Number.parseInt(b, 16))
      .filter((n) => !Number.isNaN(n) && n >= 0 && n <= 0xff);
    all.push(...bytes);
  }
  if (all.length === 0) return null;
  return { addr: base ?? fallbackAddr, bytes: new Uint8Array(all) };
}

/** Render printable ASCII, dots for everything else. */
function toAscii(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) {
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
  }
  return s;
}

/**
 * Visual hex dump — address column + two byte groups of 8 + ASCII gutter.
 * Renders a small inline table so spacing is consistent regardless of font
 * kerning, and colours the address + ASCII columns to make the structure
 * scannable. 16 bytes per row, exactly the same shape every debugger uses.
 */
export function HexDump({ addr, bytes }: { addr: number; bytes: Uint8Array }) {
  if (bytes.length === 0) {
    return (
      <div className="rounded-md border border-border/50 bg-bg/60 px-2 py-1 font-mono text-[10.5px] text-subtle">
        (empty)
      </div>
    );
  }
  const rows: { addr: number; chunk: Uint8Array }[] = [];
  for (let off = 0; off < bytes.length; off += 16) {
    rows.push({ addr: addr + off, chunk: bytes.slice(off, Math.min(off + 16, bytes.length)) });
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border/50 bg-bg/60 font-mono text-[10.5px] leading-[1.55]">
      <table className="w-full border-separate border-spacing-0">
        <tbody>
          {rows.map((r, i) => {
            const left = r.chunk.slice(0, 8);
            const right = r.chunk.slice(8);
            return (
              <tr key={r.addr} className={i % 2 === 1 ? "bg-hover/40" : undefined}>
                <td className="shrink-0 px-2 py-0.5 text-right font-mono text-subtle">
                  {r.addr.toString(16).padStart(8, "0")}
                </td>
                <td className="px-2 py-0.5">
                  <span className="text-fg/90">
                    {Array.from(left)
                      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
                      .join(" ")}
                  </span>
                  {right.length > 0 && (
                    <>
                      <span className="px-1 text-subtle/60">·</span>
                      <span className="text-fg/90">
                        {Array.from(right)
                          .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
                          .join(" ")}
                      </span>
                    </>
                  )}
                </td>
                <td className="px-2 py-0.5 text-accent/80">{toAscii(r.chunk)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Collapsible wrapper around the existing JLinkConsole — the log is the
 * long-tail, not the headline. Collapsed by default so the result card gets
 * the spotlight; expand when you actually need the raw Commander output.
 */
export function JLinkLogPanel({
  title,
  value,
  placeholder,
  defaultOpen = false,
  height = "h-48",
}: {
  title: string;
  value: string;
  placeholder: string;
  defaultOpen?: boolean;
  height?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const has = value.trim().length > 0;
  return (
    <section className="rounded-xl border border-border bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left"
      >
        <span className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-subtle">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
          {has && !open && <span className="ml-1 font-mono text-[10px] text-subtle/70">· {value.split("\n").length} 行</span>}
        </span>
        <span className="text-[10.5px] text-subtle">
          {open ? t("jlink.collapseLog") : t("jlink.expandLog")}
        </span>
      </button>
      {open && <JLinkConsole title={title} value={value} placeholder={placeholder} height={height} />}
    </section>
  );
}
