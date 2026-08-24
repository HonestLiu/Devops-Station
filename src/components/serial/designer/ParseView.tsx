import { useMemo, useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";

import { useProtocolDesignerStore } from "@/store/useProtocolDesignerStore";
import { useT, type TKey } from "@/i18n";
import { HexView } from "./HexView";
import { WaveChart } from "./WaveChart";
import { Badge, Button, Checkbox } from "@/components/ui";
import { base64ToBytes, bytesToHex } from "@/lib/utils";
import type { ParsedFrame, ParsedField, FrameDir } from "@/lib/types";

type ViewMode = "table" | "tree";

/**
 * Live / loopback parse results. Offers two render modes for each frame:
 *  - table: flat field list (name / raw / display) with linked Hex highlight
 *  - tree:  collapsible field → raw bytes + decoded value (P3)
 * An embedded waveform (P3) plots a chosen numeric field across recent frames.
 * Reply frames produced by auto-answer rules are tinted and badged.
 */
export function ParseView({
  open,
  onToggleOpen,
}: {
  open: boolean;
  onToggleOpen: () => void;
}) {
  const t = useT();
  const {
    mode,
    loopbackFrames,
    liveFrames,
    selectedField,
    selectField,
    accumulate,
    toggleAccumulate,
    clearFrames,
  } = useProtocolDesignerStore();
  const [view, setView] = useState<ViewMode>("table");

  const frames = mode === "live" ? liveFrames : loopbackFrames;

  if (frames.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <ParseViewHeader
          t={t}
          frames={frames}
          view={view}
          setView={setView}
          mode={mode}
          accumulate={accumulate}
          onToggleAccumulate={toggleAccumulate}
          onClear={clearFrames}
          disabled
          open={open}
          onToggleOpen={onToggleOpen}
        />
        {open && (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-subtle">
            {mode === "live"
              ? t("protocol.liveWaiting")
              : t("protocol.loopbackEmpty")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ParseViewHeader
        t={t}
        frames={frames}
        view={view}
        setView={setView}
        mode={mode}
        accumulate={accumulate}
        onToggleAccumulate={toggleAccumulate}
        onClear={clearFrames}
        open={open}
        onToggleOpen={onToggleOpen}
      />

      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          <WaveChart frames={frames} />
          <div className="flex flex-col gap-3">
            {frames.map((frame, i) => (
              <FrameCard
                key={i}
                frame={frame}
                view={view}
                selectedField={selectedField}
                onSelectField={selectField}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FrameCard({
  frame,
  view,
  selectedField,
  onSelectField,
}: {
  frame: ParsedFrame;
  view: ViewMode;
  selectedField: string | null;
  onSelectField: (name: string | null) => void;
}) {
  const t = useT();
  const isReply = frame.isReply ?? false;
  const dir: FrameDir = frame.dir ?? (isReply ? "reply" : "rx");

  const highlights = useMemo(
    () =>
      frame.fields.map((f) => ({
        start: f.byteOffset,
        end: f.byteOffset + f.byteLength,
        key: f.name,
      })),
    [frame.fields],
  );

  // Border / background tint by direction, so sent vs received vs reply are
  // immediately distinguishable at a glance.
  const dirStyle =
    dir === "tx"
      ? "border-sky-500/40 bg-sky-500/5"
      : dir === "reply"
        ? "border-emerald-500/40 bg-emerald-500/5"
        : frame.valid
          ? "border-border bg-surface"
          : "border-danger/40 bg-danger/5";

  return (
    <div className={"rounded-lg border " + dirStyle}>
      <div className="flex items-center justify-between border-b border-border/50 px-2.5 py-1.5">
        <div className="flex items-center gap-1.5">
          {dir === "tx" ? (
            <Badge tone="accent">{t("protocol.dirTx")}</Badge>
          ) : dir === "reply" ? (
            <Badge tone="success">{t("protocol.reply")}</Badge>
          ) : frame.valid ? (
            <Badge tone="neutral">{t("protocol.dirRx")}</Badge>
          ) : (
            <Badge tone="danger">{t("protocol.invalid")}</Badge>
          )}
          {dir !== "tx" && (
            <Badge tone={frame.checksumValid ? "success" : "danger"}>
              {frame.checksumValid ? t("protocol.crcOk") : t("protocol.crcBad")}
            </Badge>
          )}
        </div>
        <span className="font-mono text-[10px] text-subtle">
          {bytesToHex(base64ToBytes(frame.raw)).slice(0, 48)}
          {base64ToBytes(frame.raw).length > 24 ? "…" : ""}
        </span>
      </div>

      {/* Field body — table or tree mode */}
      {view === "table" ? (
        <FieldTable
          frame={frame}
          selectedField={selectedField}
          onSelectField={onSelectField}
        />
      ) : (
        <FieldTree
          frame={frame}
          selectedField={selectedField}
          onSelectField={onSelectField}
        />
      )}

      {frame.errorMsg && (
        <div className="border-t border-border/40 px-2.5 py-1 text-[11px] text-danger">
          {frame.errorMsg}
        </div>
      )}

      {/* Linked Hex */}
      <div className="border-t border-border/50 px-2.5 py-2">
        <HexView
          raw={frame.raw}
          highlights={highlights}
          activeKey={selectedField}
          onSelect={onSelectField}
        />
      </div>
    </div>
  );
}

function FieldTable({
  frame,
  selectedField,
  onSelectField,
}: {
  frame: ParsedFrame;
  selectedField: string | null;
  onSelectField: (name: string | null) => void;
}) {
  return (
    <table className="w-full border-collapse text-[12px]">
      <tbody>
        {frame.fields.map((f) => (
          <tr
            key={f.name}
            onClick={() => onSelectField(selectedField === f.name ? null : f.name)}
            className={
              "cursor-pointer border-t border-border/40 transition-colors " +
              (selectedField === f.name ? "bg-accent/10" : "hover:bg-hover")
            }
          >
            <td className="px-2.5 py-1 font-medium text-fg">{f.displayName || f.name}</td>
            <td className="px-2.5 py-1 font-mono text-muted">{f.rawValue}</td>
            <td className="px-2.5 py-1 text-fg">
              {f.displayValue}
              {f.unit ? <span className="ml-0.5 text-subtle">{f.unit}</span> : null}
            </td>
            <td className="px-2.5 py-1 text-right text-[10px] text-subtle">
              @{f.byteOffset}·{f.byteLength}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FieldTree({
  frame,
  selectedField,
  onSelectField,
}: {
  frame: ParsedFrame;
  selectedField: string | null;
  onSelectField: (name: string | null) => void;
}) {
  return (
    <ul className="border-t border-border/40 text-[12px]">
      {frame.fields.length === 0 ? (
        <li className="px-2.5 py-1.5 text-subtle">{/* reply frames carry no decoded fields */}</li>
      ) : (
        frame.fields.map((f) => (
          <FieldTreeNode
            key={f.name}
            field={f}
            depth={0}
            selected={selectedField === f.name}
            onSelect={() => onSelectField(selectedField === f.name ? null : f.name)}
          />
        ))
      )}
    </ul>
  );
}

function FieldTreeNode({
  field,
  depth,
  selected,
  onSelect,
}: {
  field: ParsedField;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <li className={selected ? "bg-accent/10" : ""}>
      <div
        className="flex cursor-pointer items-center gap-1.5 py-1 hover:bg-hover"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onSelect}
      >
        <button
          className="flex h-4 w-4 items-center justify-center rounded text-subtle hover:bg-fg/5"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          title={open ? "collapse" : "expand"}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="font-medium text-fg">{field.displayName || field.name}</span>
        {field.unit ? <span className="text-[10px] text-subtle">{field.unit}</span> : null}
        <span className="ml-auto pr-2.5 font-mono text-[11px] text-muted">{field.rawValue}</span>
        <span className="pr-2.5 text-fg">{field.displayValue}</span>
      </div>
      {open && (
        <div
          className="flex flex-wrap gap-x-4 gap-y-0.5 py-1 text-[11px] text-subtle"
          style={{ paddingLeft: 8 + depth * 14 + 20 }}
        >
          <span>offset @{field.byteOffset}</span>
          <span>len {field.byteLength}</span>
          <span>
            value {typeof field.value === "object" ? JSON.stringify(field.value) : String(field.value)}
          </span>
        </div>
      )}
    </li>
  );
}

/** Shared header strip for the parse view — shown both when there are frames
 *  and when the view is empty, so the accumulate toggle and clear button are
 *  always reachable. */
function ParseViewHeader({
  t,
  frames,
  view,
  setView,
  mode,
  accumulate,
  onToggleAccumulate,
  onClear,
  disabled,
  open,
  onToggleOpen,
}: {
  t: (k: TKey, params?: Record<string, string | number>) => string;
  frames: ParsedFrame[];
  view: ViewMode;
  setView: (v: ViewMode) => void;
  mode: "live" | "loopback";
  accumulate: boolean;
  onToggleAccumulate: () => void;
  onClear: () => void;
  disabled?: boolean;
  open: boolean;
  onToggleOpen: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onToggleOpen}
          className="flex shrink-0 items-center text-subtle hover:text-fg"
          title={open ? "collapse" : "expand"}
        >
          <ChevronRight
            size={14}
            className={"shrink-0 transition-transform " + (open ? "rotate-90" : "")}
          />
        </button>
        <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
          {t("protocol.frames")} · {frames.length}
        </span>
        <div className="flex gap-1">
          {(["table", "tree"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={
                "rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors " +
                (view === v
                  ? "bg-accent/15 text-accent"
                  : "text-subtle hover:text-fg")
              }
            >
              {v === "table" ? t("protocol.viewTable") : t("protocol.viewTree")}
            </button>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Checkbox
          checked={accumulate}
          onChange={onToggleAccumulate}
          label={t("protocol.accumulate")}
        />
        <Button
          size="sm"
          variant="ghost"
          onClick={onClear}
          disabled={disabled || frames.length === 0}
          title={t("protocol.accumulateHint")}
        >
          <Trash2 size={13} />
          {t("protocol.clearFrames")}
        </Button>
        <span className="text-[10px] text-subtle">
          {mode === "live" ? t("protocol.modeLive") : t("protocol.modeLoopback")}
        </span>
      </div>
    </div>
  );
}
