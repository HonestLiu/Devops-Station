import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { useProtocolDesignerStore } from "@/store/useProtocolDesignerStore";
import { useT } from "@/i18n";
import { Button, Field, Input } from "@/components/ui";
import { HexView } from "./HexView";
import { base64ToBytes, bytesToHex } from "@/lib/utils";
import type { ParsedFrame } from "@/lib/types";

/**
 * Offline sample parser: paste a hex string, get it parsed against the current
 * draft immediately (no loopback channel needed). Useful for designing a
 * protocol against expected device output before connecting anything.
 */
export function ProtocolPreview({
  open,
  onToggleOpen,
}: {
  open: boolean;
  onToggleOpen: () => void;
}) {
  const t = useT();
  const { draft, previewSample, sampleFrames } = useProtocolDesignerStore();
  const [hex, setHex] = useState("");

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <button
        type="button"
        onClick={onToggleOpen}
        className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle"
      >
        <ChevronRight
          size={14}
          className={"shrink-0 transition-transform " + (open ? "rotate-90" : "")}
        />
        {t("protocol.sample")}
      </button>
      {open && (
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
        <Field label={t("protocol.sampleHex")} hint={t("protocol.sampleHint")}>
          <div className="flex items-center gap-2">
            <Input
              className="flex-1 font-mono"
              value={hex}
              placeholder="AA 01 02 34 12 0D 0A"
              onChange={(e) => setHex(e.target.value)}
            />
            <Button
              size="md"
              variant="primary"
              className="shrink-0 px-4"
              onClick={() => void previewSample(hex)}
            >
              {t("protocol.parse")}
            </Button>
          </div>
        </Field>

        {sampleFrames.map((frame, i) => (
          <SampleFrame key={i} frame={frame} />
        ))}
        {sampleFrames.length === 0 && hex.trim() && (
          <div className="px-1 text-[11px] text-subtle">{t("protocol.noFrames")}</div>
        )}
      </div>
      )}
    </div>
  );
}

function SampleFrame({ frame }: { frame: ParsedFrame }) {
  const t = useT();
  const highlights = frame.fields.map((f) => ({
    start: f.byteOffset,
    end: f.byteOffset + f.byteLength,
    key: f.name,
  }));
  return (
    <div
      className={
        "rounded-lg border " +
        (frame.valid ? "border-border bg-surface" : "border-danger/40 bg-danger/5")
      }
    >
      <div className="flex items-center gap-1.5 border-b border-border/50 px-2.5 py-1">
        <span className="font-mono text-[10px] text-subtle">
          {bytesToHex(base64ToBytes(frame.raw))}
        </span>
      </div>
      <table className="w-full border-collapse text-[12px]">
        <tbody>
          {frame.fields.map((f) => (
            <tr key={f.name} className="border-t border-border/40">
              <td className="px-2.5 py-1 font-medium text-fg">{f.displayName || f.name}</td>
              <td className="px-2.5 py-1 text-fg">
                {f.displayValue}
                {f.unit ? <span className="ml-0.5 text-subtle">{f.unit}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-border/50 px-2.5 py-2">
        <HexView raw={frame.raw} highlights={highlights} />
      </div>
    </div>
  );
}
