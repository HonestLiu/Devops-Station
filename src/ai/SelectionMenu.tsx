import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Send,
  Sparkles,
  Terminal as TerminalIcon,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { useAiComposer } from "./useAiComposer";
import { ASK_SYSTEM, EXPLAIN_SYSTEM, FIX_SYSTEM, GENERATE_SYSTEM } from "./terminalAi";

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
  const [askOpen, setAskOpen] = useState(false);
  const [askInput, setAskInput] = useState("");
  // The terminal selection we ask about. Captured when the ask box opens, so that
  // focusing the input (which clears the xterm selection) doesn't wipe it.
  const [askContext, setAskContext] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const safe = text.trim();

  const openAskBox = (ctx: string) => {
    if (!ctx) return;
    setAskContext(ctx);
    setOpen(false);
    setAskOpen(true);
    requestAnimationFrame(() => askRef.current?.focus());
  };

  // Open the free-form "ask" input when requested from elsewhere (e.g. the
  // terminal's right-click menu), then consume the one-shot signal.
  const requestAsk = useAiComposer((s) => s.requestAsk);
  useEffect(() => {
    if (!requestAsk) return;
    const ctx = useAiComposer.getState().askContext ?? safe;
    useAiComposer.getState().consumeAsk();
    if (ctx) openAskBox(ctx);
  }, [requestAsk, safe]);

  // Close on outside interaction — but never let the click clear the xterm
  // selection; the popover container itself swallows mousedown (except on the
  // input, which must keep its default focus/caret behaviour).
  useEffect(() => {
    if (!open && !askOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setAskOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, askOpen]);

  const run = (message: string, system: string) => {
    setOpen(false);
    if (!safe) return;
    useAiComposer.getState().setPrefill(message, true, system);
  };

  // Free-form question: the user's own question + the selected text as context.
  const submitAsk = () => {
    const q = askInput.trim();
    if (!q || !askContext) return;
    const message = `${q}\n\n${t("ai.askContext")}\n${askContext}`;
    setAskOpen(false);
    setAskInput("");
    setOpen(false);
    useAiComposer.getState().setPrefill(message, true, ASK_SYSTEM);
  };

  // Render nothing unless there is a selection OR the ask box is already open.
  if (!safe && !askOpen) return null;

  // Only swallow mousedown (to preserve the xterm selection) for non-input
  // elements; the input must keep its default focus behaviour.
  const swallowMouse = (e: React.MouseEvent) => {
    const tag = (e.target as HTMLElement).tagName;
    if (tag !== "INPUT" && tag !== "TEXTAREA") e.preventDefault();
  };

  return (
    <div ref={ref} className="absolute right-2 top-2 z-[60]">
      {askOpen ? (
        <div
          onMouseDown={swallowMouse}
          className="absolute right-0 mt-1 w-72 rounded-lg border border-border bg-surface p-2 shadow-xl"
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-subtle">
            {t("ai.ask")}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              ref={askRef}
              value={askInput}
              onChange={(e) => setAskInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitAsk();
                } else if (e.key === "Escape") {
                  setAskOpen(false);
                }
              }}
              placeholder={t("ai.askPlaceholder")}
              className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-fg outline-none placeholder:text-subtle focus:border-accent"
            />
            <button
              type="button"
              onClick={submitAsk}
              disabled={!askInput.trim()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-fg transition hover:brightness-110 disabled:opacity-40"
              title={t("ai.askSend")}
            >
              <Send size={13} />
            </button>
          </div>
        </div>
      ) : (
        <>
          {safe && (
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
          )}
          {open && safe && (
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
              <div className="my-1 h-px bg-border/70" />
              <MenuItem
                icon={<Send size={13} />}
                label={t("ai.ask")}
                onClick={() => openAskBox(safe)}
              />
            </div>
          )}
        </>
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
