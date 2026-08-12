import { Columns2, Rows2, SquareX } from "lucide-react";

import { Button } from "@/components/ui";
import { useT } from "@/i18n";
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
  const t = useT();
  return (
    <>
      <div className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="sm"
        disabled={!canSplit}
        onClick={() => onSplit("col")}
        title={canSplit ? t("split.splitRight") : t("split.max4")}
      >
        <Columns2 size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!canSplit}
        onClick={() => onSplit("row")}
        title={canSplit ? t("split.splitBelow") : t("split.max4")}
      >
        <Rows2 size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!canClosePane}
        onClick={onClosePane}
        title={canClosePane ? t("split.closePane") : t("split.onePane")}
        className={cn(paneCount > 1 && "text-danger hover:text-danger")}
      >
        <SquareX size={14} />
      </Button>
      <div className="mx-1 h-4 w-px bg-border" />
    </>
  );
}
