import { Check, ChevronDown, Eye, EyeOff, X } from "lucide-react";
import {
  Children,
  forwardRef,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
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

// --- Side icon button ------------------------------------------------------
// Square, icon-only button used in the headers of side panels (Files / USB /
// AI). Kept visually identical across panels so the right-rail feels like one
// family.

export function SideIconButton({
  icon,
  label,
  onClick,
  active,
  disabled,
  className,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={disabled}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-hover hover:text-fg",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
        active && "bg-accent/15 text-accent",
        className,
      )}
    >
      {icon}
    </button>
  );
}


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

// --- Textarea --------------------------------------------------------------
// Multi-line input (snippet content, logs, …). Same visual language as `Input`,
// but `resize-y` + `whitespace-pre` + `font-mono` so command text keeps its
// line breaks and indentation.

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    spellCheck={false}
    autoComplete="off"
    className={cn(
      "w-full rounded-lg border border-border bg-bg px-2.5 py-2 text-[13px] text-fg",
      "placeholder:text-subtle",
      "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/40",
      "disabled:opacity-50",
      "min-h-[96px] resize-y whitespace-pre font-mono leading-relaxed",
      className,
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

// --- PasswordInput ---------------------------------------------------------

export const PasswordInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(({ className, type, ...props }, ref) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={show ? "text" : "password"}
        className={cn("pr-9 [&::-ms-clear]:hidden [&::-ms-reveal]:hidden", className)}
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((v) => !v)}
        aria-label={show ? "隐藏密码" : "显示密码"}
        title={show ? "隐藏密码" : "显示密码"}
        className={cn(
          "absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded",
          "text-subtle transition-colors hover:bg-fg/5 hover:text-fg",
          "focus:outline-none focus:ring-1 focus:ring-accent/40",
        )}
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  );
});
PasswordInput.displayName = "PasswordInput";

// --- Select ----------------------------------------------------------------
//
// A custom-styled dropdown that mirrors the native `<select>` API (controlled
// `value` + `onChange` carrying a ChangeEvent with `e.target.value`), so every
// existing call site is beautified without changes. `option`/`optgroup` children
// are parsed into a floating menu that matches the app's dark theme.

interface ParsedOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}
interface ParsedGroup {
  label: string;
  options: ParsedOption[];
}

function parseOptions(children: ReactNode): ParsedGroup[] {
  const groups: ParsedGroup[] = [];
  let current: ParsedGroup | null = null;
  const push = (el: ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>) => {
    const raw = el.props.value;
    const value = raw !== undefined && raw !== null ? String(raw) : undefined;
    const label = (el.props.children ?? value ?? "") as ReactNode;
    if (!current) {
      current = { label: "", options: [] };
      groups.push(current);
    }
    current.options.push({ value: value ?? String(label), label, disabled: el.props.disabled });
  };
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const el = child as ReactElement<{ label?: string; disabled?: boolean; children?: ReactNode }>;
    if (el.type === "optgroup") {
      current = { label: String(el.props.label ?? ""), options: [] };
      groups.push(current);
      Children.forEach(el.props.children, (c) => {
        if (isValidElement(c)) push(c as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>);
      });
    } else if (el.type === "option") {
      push(el as ReactElement<{ value?: string | number; disabled?: boolean; children?: ReactNode }>);
    }
  });
  return groups;
}

export interface SelectProps {
  className?: string;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (e: ChangeEvent<HTMLSelectElement>) => void;
  disabled?: boolean;
  placeholder?: string;
  title?: string;
  id?: string;
  name?: string;
  children?: ReactNode;
}

export function Select({
  className,
  children,
  value,
  defaultValue,
  onChange,
  disabled,
  placeholder,
  title,
  id,
  name,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => parseOptions(children), [children]);
  const flat = groups.flatMap((g) => g.options);
  const selected = String(value ?? defaultValue ?? "");
  const current = flat.find((o) => o.value === selected);

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

  const commit = (val: string) => {
    setOpen(false);
    // Preserve the native onChange contract so callers that read
    // `e.target.value` keep working unchanged.
    const evt = {
      target: { value: val },
      currentTarget: { value: val },
      preventDefault: () => {},
      stopPropagation: () => {},
    } as unknown as ChangeEvent<HTMLSelectElement>;
    onChange?.(evt);
  };

  return (
    <div ref={ref} className="relative inline-block w-full">
      <button
        type="button"
        id={id}
        name={name}
        title={title}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        className={cn(
          "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-border bg-bg px-2 text-[13px] text-fg transition-colors hover:border-accent/40",
          open && "border-accent/60",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
      >
        <span className={cn("min-w-0 truncate text-left", !current && "text-muted")}>
          {current ? current.label : (placeholder ?? "Select…")}
        </span>
        <ChevronDown
          size={14}
          className={cn("shrink-0 text-subtle transition-transform", open && "rotate-180")}
        />
      </button>

      {open && !disabled && (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-elevated py-1 shadow-2xl">
          {groups.map((g, gi) => (
            <div key={gi}>
              {g.label && (
                <div className="px-2.5 pb-1 pt-1.5 text-[10px] uppercase tracking-wide text-subtle">
                  {g.label}
                </div>
              )}
              {g.options.map((o) => {
                const active = o.value === selected;
                return (
                  <button
                    type="button"
                    key={o.value}
                    disabled={o.disabled}
                    onClick={() => commit(o.value)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-[13px] text-fg transition-colors hover:bg-accent/10 hover:text-accent",
                      active && "bg-accent/10 text-accent",
                      o.disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <span className="min-w-0 truncate">{o.label}</span>
                    {active && <Check size={13} className="shrink-0 text-accent" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
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
  label?: string;
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

// --- Switch (styled toggle) ------------------------------------------------

export function Switch({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex cursor-pointer select-none items-center gap-2",
        className,
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full",
          "transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-accent/40",
          checked ? "bg-accent" : "bg-border",
        )}
      >
        <span
          className={cn(
            "inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform duration-150",
            checked ? "translate-x-[15px]" : "translate-x-[3px]",
          )}
        />
      </button>
      {label && <span className="text-[13px] text-fg">{label}</span>}
    </label>
  );
}

// --- Module header (page / workspace chrome strip) -------------------------

/**
 * The chrome strip pinned to the top of a module page or workspace tab —
 * same anatomy as the MQTT/Serial headers: inline icon + title, status badges
 * right after the title, controls pinned right. `no-drag` keeps the right
 * cluster clickable inside the Tauri titlebar drag region.
 */
export function ModuleHeader({
  icon,
  title,
  badges,
  actions,
}: {
  icon: ReactNode;
  title: string;
  /** Status badges, rendered inline right after the title. */
  badges?: ReactNode;
  /** Controls pinned to the right (e.g. an encoding select). */
  actions?: ReactNode;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-accent">{icon}</span>
        <h1 className="truncate text-[13px] font-semibold text-fg">{title}</h1>
        {badges && <div className="flex shrink-0 items-center gap-1.5">{badges}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2 no-drag">{actions}</div>}
    </div>
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

// --- Drawer (right-side slide-in) ------------------------------------------

export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "w-[360px]",
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
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        className={cn(
          "absolute right-0 top-0 flex h-full max-w-full flex-col border-l border-border bg-elevated shadow-2xl animate-slide-in",
          width,
        )}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-semibold text-fg">{title}</h2>
            {description && <p className="mt-0.5 text-[12px] text-muted">{description}</p>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            <X size={14} />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
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
