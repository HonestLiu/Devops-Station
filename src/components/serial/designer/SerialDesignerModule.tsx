import { useEffect, useState } from "react";
import { FileCode2, FileCog, Play, Square } from "lucide-react";

import { useT } from "@/i18n";
import { ModuleHeader, Badge, Button } from "@/components/ui";
import { useProtocolDesignerStore } from "@/store/useProtocolDesignerStore";
import { ProtocolList } from "./ProtocolList";
import { ProtocolEditor } from "./ProtocolEditor";
import { ProtocolPreview } from "./ProtocolPreview";
import { ParseView } from "./ParseView";
import { StructuredSend } from "./StructuredSend";
import { ExportCDialog } from "./ExportCDialog";

/** Small amber "Beta" pill — mirrors the one used on J-Link's RTT module card. */
function BetaBadge() {
  return (
    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500 ring-1 ring-inset ring-amber-500/30">
      Beta
    </span>
  );
}

/**
 * The "协议设计器" module — a full protocol workbench (Beta). It is decoupled
 * from the serial transport: it never opens a port itself. Two feed modes:
 *  - loopback: an offline virtual channel the backend parses (no device needed)
 *  - live:    binds to a connected serial/ble tab and parses its inbound bytes
 * The editor, preview, parse view and structured send all share one draft
 * protocol held in `useProtocolDesignerStore`.
 */
export function SerialDesignerModule() {
  const t = useT();
  const {
    mode,
    loopbackId,
    draft,
    openLoopback,
    closeLoopback,
    reloadLoopback,
    setMode,
  } = useProtocolDesignerStore();

  const [exportOpen, setExportOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);
  const [parseOpen, setParseOpen] = useState(true);
  const [sendOpen, setSendOpen] = useState(true);

  // Switching away from loopback tears the channel down; switching to it with
  // a saved protocol can auto-open. We auto-open only on explicit toggle below.
  // (Loopback frame subscription lives in the store so it is established
  // before any frame is sent — see `openLoopback`.)
  useEffect(() => {
    if (mode !== "loopback" && loopbackId) {
      void closeLoopback();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleToggleLoopback = async () => {
    if (loopbackId) {
      await closeLoopback();
    } else {
      await openLoopback();
    }
  };

  /** Persist + push the draft into a running loopback without closing it. */
  const handleReload = async () => {
    await reloadLoopback();
  };

  return (
    <div className="flex h-full flex-col bg-bg">
      <ModuleHeader
        icon={<FileCog size={15} />}
        title={t("serial.designerTitle")}
        badges={<BetaBadge />}
        actions={
          <div className="flex items-center gap-2">
            {mode === "loopback" && (
              <Button
                size="sm"
                variant={loopbackId ? "danger" : "primary"}
                onClick={() => void handleToggleLoopback()}
              >
                {loopbackId ? <Square size={13} /> : <Play size={13} />}
                {loopbackId ? t("protocol.loopbackStop") : t("protocol.loopbackStart")}
              </Button>
            )}
            {mode === "loopback" && loopbackId && (
              <Button size="sm" variant="secondary" onClick={() => void handleReload()}>
                {t("protocol.reload")}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => setExportOpen(true)}>
              <FileCode2 size={13} />
              {t("protocol.exportC")}
            </Button>
            <Badge tone="neutral">{mode === "live" ? t("protocol.modeLive") : t("protocol.modeLoopback")}</Badge>
          </div>
        }
      />

      <div className="grid min-h-0 flex-1 grid-cols-[220px_1fr_360px]">
        {/* Left: protocol list + mode/target */}
        <div className="min-h-0 border-r border-border/60 bg-surface">
          <ProtocolList dir="rx" />
        </div>

        {/* Center: editor (top) + preview (bottom). When the preview is
            collapsed it drops to the bottom (mt-auto) and gives its space to
            the editor. */}
        <div className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-[3] border-b border-border/60">
            <ProtocolEditor />
          </div>
          <div
            className={
              "min-h-0 border-border/60 " +
              (previewOpen ? "flex-[2] border-t" : "flex-none mt-auto")
            }
          >
            <ProtocolPreview open={previewOpen} onToggleOpen={() => setPreviewOpen((v) => !v)} />
          </div>
        </div>

        {/* Right: parse results (top) + structured send (bottom). A collapsed
            panel shrinks to its header and sinks to the bottom (mt-auto), so
            the other panel reclaims the freed space. */}
        <div className="flex min-h-0 flex-col border-l border-border/60">
          <div
            className={
              "min-h-0 border-b border-border/60 " +
              (parseOpen ? "flex-1" : "flex-none mt-auto")
            }
          >
            <ParseView open={parseOpen} onToggleOpen={() => setParseOpen((v) => !v)} />
          </div>
          <div className={"min-h-0 " + (sendOpen ? "flex-1 border-t border-border/60" : "flex-none")}>
            <StructuredSend open={sendOpen} onToggleOpen={() => setSendOpen((v) => !v)} />
          </div>
        </div>
      </div>

      <ExportCDialog open={exportOpen} onClose={() => setExportOpen(false)} config={draft} />
    </div>
  );
}
