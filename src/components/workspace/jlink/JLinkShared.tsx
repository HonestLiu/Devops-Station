import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

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
 * modules read the same.
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
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [value]);

  return (
    <section className="rounded-xl border border-border bg-surface">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-2.5">
        <h2 className="text-[12px] font-semibold uppercase tracking-wide text-subtle">{title}</h2>
        {right}
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
