import { useState } from "react";
import { CornerDownLeft, Sparkles } from "lucide-react";

import { Button } from "@/components/ui";
import { generateCommand, explainSelection } from "./terminalAi";
import { analyzeTerminal } from "./tasks";
import { useTerminalSelection } from "./terminalBridge";
import type { Tab } from "@/lib/types";

/**
 * Toolbar button that opens a small AI popover: type a natural-language request
 * to generate a shell command, or explain the text currently selected in the
 * terminal. The actual work is delegated to the Terminal AI engine.
 */
export function TerminalAiButton({ tab }: { tab: Tab }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const hasSelection = useTerminalSelection((s) => !!s.text.trim());

  const doGenerate = () => {
    const p = prompt.trim();
    if (!p) return;
    setPrompt("");
    setOpen(false);
    generateCommand(p);
  };

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title="AI assistant: generate or explain commands"
      >
        <Sparkles size={14} />
        AI
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border border-border bg-elevated p-3 shadow-xl">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">
              Ask AI to generate a command
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  doGenerate();
                }
              }}
              rows={3}
              autoFocus
              placeholder="e.g. find the 10 largest files under /var"
              className="w-full resize-none rounded-md border border-border bg-bg p-2 text-[12px] text-fg outline-none placeholder:text-subtle focus:border-accent/50"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                onClick={() => {
                  setOpen(false);
                  explainSelection();
                }}
                disabled={!hasSelection}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-hover disabled:opacity-40"
                title={
                  hasSelection
                    ? "Explain the selected terminal text"
                    : "Select text in the terminal first"
                }
              >
                Explain selection
              </button>
              <button
                onClick={() => {
                  setOpen(false);
                  analyzeTerminal();
                }}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-hover"
                title="Analyze the terminal screen as a log"
              >
                Analyze log
              </button>
              <button
                onClick={doGenerate}
                disabled={!prompt.trim()}
                className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg disabled:opacity-40"
              >
                <CornerDownLeft size={12} /> Generate
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
