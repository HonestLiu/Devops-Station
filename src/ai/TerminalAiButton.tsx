import { Sparkles } from "lucide-react";

import { Button } from "@/components/ui";
import { useAiStore } from "./useAiStore";
import type { Tab } from "@/lib/types";

/**
 * Toolbar button that toggles the AI assistant panel (right-aligned docked
 * panel with collapsible chat history). The panel itself lives in AiPanel.
 */
export function TerminalAiButton({ tab: _tab }: { tab: Tab }) {
  const open = useAiStore((s) => s.panelOpen);

  return (
    <Button
      variant={open ? "primary" : "ghost"}
      size="sm"
      onClick={() => useAiStore.getState().togglePanel()}
      title={open ? "Collapse AI assistant" : "Open AI assistant: chat, commands, log analysis…"}
    >
      <Sparkles size={14} />
      AI
    </Button>
  );
}
