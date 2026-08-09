import { X } from "lucide-react";
import {
  forwardRef,
  useEffect,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

// --- Button ----------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-fg hover:brightness-110 active:brightness-95 disabled:opacity-50",
  secondary:
    "bg-elevated text-fg border border-border hover:bg-hover disabled:opacity-50",
  ghost: "text-muted hover:bg-hover hover:text-fg disabled:opacity-40",
  danger: "bg-danger text-white hover:brightness-110 disabled:opacity-50",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium",
        "transition-[background-color,filter,opacity,box-shadow] duration-100",
        "disabled:cursor-not-allowed",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = "Button";

// --- Input -----------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        "h-8 w-full rounded-lg border border-border bg-bg px-2.5 text-[13px] text-fg",
        "placeholder:text-subtle",
        "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

// --- Select ----------------------------------------------------------------

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-8 w-full rounded-lg border border-border bg-bg px-2 text-[13px] text-fg",
      "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40",
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";

// --- Field -----------------------------------------------------------------

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1", className)}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-subtle">
        {label}
      </span>
      {children}
      {error ? (
        <span className="text-[11px] text-danger">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-subtle">{hint}</span>
      ) : null}
    </label>
  );
}

// --- Checkbox --------------------------------------------------------------

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-2 text-[13px] text-fg">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
      />
      {label}
    </label>
  );
}

// --- Badge -----------------------------------------------------------------

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  className?: string;
}) {
  const tones = {
    neutral: "bg-hover text-muted",
    accent: "bg-accent/15 text-accent",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-danger/15 text-danger",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// --- Dialog ----------------------------------------------------------------

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        className={cn(
          "relative w-full animate-scale-in rounded-lg border border-border bg-elevated shadow-2xl",
          width,
        )}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-fg">{title}</h2>
            {description && (
              <p className="mt-0.5 text-[12px] text-muted">{description}</p>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X size={14} />
          </Button>
        </header>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}

// --- Empty state -----------------------------------------------------------

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      {icon && <div className="mb-1 text-subtle">{icon}</div>}
      <p className="text-[13px] font-medium text-muted">{title}</p>
      {description && (
        <p className="max-w-sm text-[12px] leading-relaxed text-subtle">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// --- Progress bar ----------------------------------------------------------

export function Bar({
  value,
  tone,
  className,
}: {
  /** 0–100 */
  value: number;
  tone?: "accent" | "success" | "warning" | "danger";
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  // Colour by severity unless the caller pins a tone.
  const resolved = tone ?? (pct > 90 ? "danger" : pct > 75 ? "warning" : "accent");
  const fills = {
    accent: "bg-accent",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
  } as const;

  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-hover", className)}>
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", fills[resolved])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// --- Keyboard hint ---------------------------------------------------------

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-bg px-1.5 py-0.5 font-mono text-[10px] text-subtle">
      {children}
    </kbd>
  );
}
