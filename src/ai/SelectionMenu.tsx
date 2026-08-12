import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Sparkles,
  Terminal as TerminalIcon,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { useAiComposer } from "./useAiComposer";
import { EXPLAIN_SYSTEM, FIX_SYSTEM, GENERATE_SYSTEM } from "./terminalAi";

/**
 * A small "selection-aware" AI menu that floats over the terminal while text is
 * selected. Each action builds a tailored prompt and routes it to the inline
 * composer (so the answer streams back inside the terminal, not a side panel).
 *
 * This is what replaces the old single "Explain" button — instead of one
 * hard-coded action, the selection becomes a verb menu: explain, fix, or turn
 * it into a command.
 */
export function SelectionMenu({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const safe = text.trim();

  // Close on outside interaction — but never let the click clear the xterm
  // selection; the popover container itself swallows mousedown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const run = (message: string, system: string) => {
    setOpen(false);
    if (!safe) return;
    useAiComposer.getState().setPrefill(message, true, system);
  };

  if (!safe) return null;

  return (
    <div ref={ref} className="absolute right-2 top-2 z-[60]">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-fg shadow-lg hover:opacity-90"
        title={t("ai.quickActions")}
      >
        <Sparkles size={12} /> AI
        <ChevronDown size={11} className={cn("transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          onMouseDown={(e) => e.preventDefault()}
          className="absolute right-0 mt-1 w-44 rounded-lg border border-border bg-surface p-1 shadow-xl"
        >
          <MenuItem
            icon={<Sparkles size={13} />}
            label={t("ai.explain")}
            onClick={() =>
              run(`Explain the following terminal selection:\n\n${safe}`, EXPLAIN_SYSTEM)
            }
          />
          <MenuItem
            icon={<Wrench size={13} />}
            label={t("ai.fixIt")}
            onClick={() =>
              run(
                `Here is the terminal excerpt:\n\n${safe}\n\nWhat went wrong and how do I fix it?`,
                FIX_SYSTEM,
              )
            }
          />
          <MenuItem
            icon={<TerminalIcon size={13} />}
            label={t("ai.rewriteCommand")}
            onClick={() =>
              run(
                `Turn the following into the shell command(s) I should run:\n\n${safe}`,
                GENERATE_SYSTEM,
              )
            }
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg transition-colors hover:bg-hover"
    >
      <span className="text-subtle">{icon}</span>
      {label}
    </button>
  );
}
