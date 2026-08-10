import { Columns2, Rows2, SquareX } from "lucide-react";

import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

/**
 * Split-pane toolbar controls shared by SSH / Local / WSL workspaces:
 * split right, split below, close focused pane. Wrapped in dividers.
 */
export function SplitControls({
  paneCount,
  canSplit,
  canClosePane,
  onSplit,
  onClosePane,
}: {
  paneCount: number;
  canSplit: boolean;
  canClosePane: boolean;
  onSplit: (axis: "col" | "row") => void;
  onClosePane: () => void;
}) {
  return (
    <>
      <div className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="sm"
        disabled={!canSplit}
        onClick={() => onSplit("col")}
        title={canSplit ? "Split right (Ctrl+Shift+D)" : "Max 4 screens"}
      >
        <Columns2 size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!canSplit}
        onClick={() => onSplit("row")}
        title={canSplit ? "Split below (Ctrl+Shift+E)" : "Max 4 screens"}
      >
        <Rows2 size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!canClosePane}
        onClick={onClosePane}
        title={canClosePane ? "Close focused pane (Ctrl+Shift+W)" : "Only one pane"}
        className={cn(paneCount > 1 && "text-danger hover:text-danger")}
      >
        <SquareX size={14} />
      </Button>
      <div className="mx-1 h-4 w-px bg-border" />
    </>
  );
}
