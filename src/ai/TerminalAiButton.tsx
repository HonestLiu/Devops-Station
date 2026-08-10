import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui";
import { useAiStore } from "./useAiStore";
import type { Tab } from "@/lib/types";

/**
 * Secondary entry point to the full AI assistant panel (chat history, knowledge
 * base, agent mode). The *primary* entry is now the inline composer docked at
 * the bottom of the terminal, so this is intentionally a quiet icon — the panel
 * itself is on-demand.
 */
export function TerminalAiButton({ tab: _tab }: { tab: Tab }) {
  const open = useAiStore((s) => s.panelOpen);

  return (
    <Button
      variant={open ? "secondary" : "ghost"}
      size="sm"
      onClick={() => useAiStore.getState().togglePanel()}
      title={open ? "Collapse AI assistant" : "Open AI assistant (history, knowledge base, agent)"}
    >
      <Sparkles size={14} />
    </Button>
  );
}
