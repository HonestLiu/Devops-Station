import { ArrowDown, ArrowUp, ChevronRight, Copy, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useProtocolDesignerStore } from "@/store/useProtocolDesignerStore";
import { useT } from "@/i18n";
import { Button, Checkbox, Field, Input, Select, Switch } from "@/components/ui";
import type {
  ChecksumAlgo,
  Endian,
  FieldDataType,
  FieldDef,
  ProtocolConfig,
} from "@/lib/types";

const DATA_TYPES: FieldDataType[] = [
  "uint8",
  "int16",
  "uint16",
  "int32",
  "uint32",
  "float32",
  "float64",
  "hexstring",
  "asciistring",
  "bitfield",
];

const CHECKSUMS: ChecksumAlgo[] = [
  "none",
  "sum",
  "xor",
  "crc8",
  "crc16modbus",
  "crc32",
];

/**
 * The frame-building editor: global protocol settings (frame head/tail, length
 * field, endianness, timeout, checksum) plus the dynamic field list. Every edit
 * mutates the in-memory draft; persistence happens via the list's Save button.
 */
export function ProtocolEditor() {
  const t = useT();
  const draft = useProtocolDesignerStore((s) => s.draft);
  const updateDraft = useProtocolDesignerStore((s) => s.updateDraft);
  const updateField = useProtocolDesignerStore((s) => s.updateField);
  const addField = useProtocolDesignerStore((s) => s.addField);
  const removeField = useProtocolDesignerStore((s) => s.removeField);
  const duplicateField = useProtocolDesignerStore((s) => s.duplicateField);
  const moveField = useProtocolDesignerStore((s) => s.moveField);
  const addRule = useProtocolDesignerStore((s) => s.addRule);

  const f = draft.fields;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* Global settings */}
        <CollapsibleSection title={t("protocol.global")} defaultOpen>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Field label={t("protocol.name")}>
              <Input
                value={draft.name}
                onChange={(e) => updateDraft({ name: e.target.value })}
              />
            </Field>
            <Field label={t("protocol.endian")}>
              <Select
                value={draft.endian ?? "big"}
                onChange={(e) => updateDraft({ endian: (e.target.value as Endian) || null })}
              >
                <option value="big">{t("protocol.bigEndian")}</option>
                <option value="little">{t("protocol.littleEndian")}</option>
              </Select>
            </Field>
            <Field label={t("protocol.timeoutMs")}>
              <Input
                type="number"
                min={0}
                value={draft.timeoutMs}
                onChange={(e) => updateDraft({ timeoutMs: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label={t("protocol.head")} hint={t("protocol.headHint")}>
              <Input
                value={normalizeHexDisplay(draft.head)}
                placeholder="AA BB"
                onChange={(e) => updateDraft({ head: e.target.value === "" ? null : e.target.value })}
              />
            </Field>
            <Field label={t("protocol.tail")} hint={t("protocol.tailHint")}>
              <Input
                value={normalizeHexDisplay(draft.tail)}
                placeholder="0D 0A"
                onChange={(e) => updateDraft({ tail: e.target.value === "" ? null : e.target.value })}
              />
            </Field>
            <Field label={t("protocol.checksum")}>
              <Select
                value={draft.checksum?.algo ?? "none"}
                onChange={(e) =>
                  updateDraft({
                    checksum:
                      e.target.value === "none"
                        ? null
                        : { algo: e.target.value as ChecksumAlgo, start: null, end: null },
                  })
                }
              >
                {CHECKSUMS.map((c) => (
                  <option key={c} value={c}>
                    {t(`protocol.checksum_${c}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* Length field (optional) */}
          <LengthFieldEditor draft={draft} updateDraft={updateDraft} />
        </CollapsibleSection>

        {/* Fields */}
        <CollapsibleSection
          title={t("protocol.fields")}
          defaultOpen
          right={
            <Button size="sm" variant="secondary" onClick={addField}>
              <Plus size={13} /> {t("protocol.addField")}
            </Button>
          }
        >
          {f.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-[12px] text-subtle">
              {t("protocol.noFields")}
            </div>
          ) : (
            <FieldTable
              fields={f}
              updateField={updateField}
              moveField={moveField}
              duplicateField={duplicateField}
              removeField={removeField}
            />
          )}
        </CollapsibleSection>

        {/* Auto-answer (P2) */}
        <CollapsibleSection
          title={t("protocol.autoAnswer")}
          defaultOpen
          right={
            <Button size="sm" variant="secondary" onClick={addRule}>
              <Plus size={13} /> {t("protocol.addRule")}
            </Button>
          }
        >
          <AutoAnswerBody />
        </CollapsibleSection>
      </div>
    </div>
  );
}

/** Draggable field table. Each row has a drag handle; reordering updates the
 *  field order in the draft (mirrors the up/down buttons, but via DnD). */
function FieldTable({
  fields,
  updateField,
  moveField,
  duplicateField,
  removeField,
}: {
  fields: FieldDef[];
  updateField: (i: number, p: Partial<FieldDef>) => void;
  moveField: (i: number, d: -1 | 1) => void;
  duplicateField: (i: number) => void;
  removeField: (i: number) => void;
}) {
  const t = useT();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="text-left text-subtle">
            <th className="px-1 py-1 font-medium" />
            <th className="px-1 py-1 font-medium">{t("protocol.colName")}</th>
            <th className="px-1 py-1 font-medium">{t("protocol.colDisplay")}</th>
            <th className="px-1 py-1 font-medium">{t("protocol.colOffset")}</th>
            <th className="px-1 py-1 font-medium">{t("protocol.colLength")}</th>
            <th className="px-1 py-1 font-medium">{t("protocol.colType")}</th>
            <th className="px-1 py-1 font-medium">{t("protocol.colScale")}</th>
            <th className="px-1 py-1 font-medium">{t("protocol.colUnit")}</th>
            <th className="px-1 py-1 font-medium">{t("protocol.colCond")}</th>
            <th className="px-1 py-1"></th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field, i) => (
            <tr
              key={i}
              className={
                "border-t border-border/50 align-top " +
                (overIdx === i && dragIdx !== null && dragIdx !== i ? "bg-accent/5 " : "") +
                (dragIdx === i ? "opacity-50 " : "")
              }
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIdx(i);
              }}
              onDrop={() => {
                if (dragIdx !== null && dragIdx !== i) {
                  // Move by swapping repeatedly toward target.
                  const step = dragIdx < i ? 1 : -1;
                  let cur = dragIdx;
                  while (cur !== i) {
                    moveField(cur, step);
                    cur += step;
                  }
                }
                setDragIdx(null);
                setOverIdx(null);
              }}
              onDragEnd={() => {
                setDragIdx(null);
                setOverIdx(null);
              }}
            >
              <td className="px-1 py-1">
                <span
                  className="cursor-grab select-none text-subtle active:cursor-grabbing"
                  title={t("protocol.dragHint")}
                >
                  ⠿
                </span>
              </td>
              <td className="px-1 py-1">
                <Input
                  className="h-7"
                  value={field.name}
                  onChange={(e) => updateField(i, { name: e.target.value })}
                />
              </td>
              <td className="px-1 py-1">
                <Input
                  className="h-7"
                  value={field.displayName}
                  onChange={(e) => updateField(i, { displayName: e.target.value })}
                />
              </td>
              <td className="px-1 py-1">
                <Input
                  className="h-7 w-16"
                  type="number"
                  min={0}
                  value={field.offset}
                  onChange={(e) => updateField(i, { offset: Number(e.target.value) || 0 })}
                />
              </td>
              <td className="px-1 py-1">
                <Input
                  className="h-7 w-16"
                  type="number"
                  min={1}
                  value={field.length}
                  onChange={(e) => updateField(i, { length: Math.max(1, Number(e.target.value) || 1) })}
                />
              </td>
              <td className="px-1 py-1">
                <Select
                  className="h-7"
                  value={field.dataType}
                  onChange={(e) => updateField(i, { dataType: e.target.value as FieldDataType })}
                >
                  {DATA_TYPES.map((dt) => (
                    <option key={dt} value={dt}>
                      {dt}
                    </option>
                  ))}
                </Select>
              </td>
              <td className="px-1 py-1">
                <Input
                  className="h-7 w-16"
                  type="number"
                  step="any"
                  value={field.scale ?? ""}
                  placeholder="1"
                  onChange={(e) =>
                    updateField(i, {
                      scale: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </td>
              <td className="px-1 py-1">
                <Input
                  className="h-7 w-14"
                  value={field.unit ?? ""}
                  onChange={(e) => updateField(i, { unit: e.target.value || null })}
                />
              </td>
              <td className="px-1 py-1">
                <Input
                  className="h-7 w-28 font-mono"
                  value={field.condition ?? ""}
                  placeholder="cmd == 1"
                  title={t("protocol.condHint")}
                  onChange={(e) => updateField(i, { condition: e.target.value.trim() || null })}
                />
              </td>
              <td className="px-1 py-1">
                <div className="flex items-center gap-0.5">
                  <EnumButton index={i} field={field} />
                  <button
                    title={t("protocol.moveUp")}
                    className="rounded p-1 text-muted hover:bg-fg/5 hover:text-fg"
                    onClick={() => moveField(i, -1)}
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    title={t("protocol.moveDown")}
                    className="rounded p-1 text-muted hover:bg-fg/5 hover:text-fg"
                    onClick={() => moveField(i, 1)}
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    title={t("protocol.duplicate")}
                    className="rounded p-1 text-muted hover:bg-fg/5 hover:text-fg"
                    onClick={() => duplicateField(i)}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    title={t("protocol.delete")}
                    className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
                    onClick={() => removeField(i)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline enum-map editor (toggle popover). */
function EnumButton({ index, field }: { index: number; field: FieldDef }) {
  const t = useT();
  const updateField = useProtocolDesignerStore((s) => s.updateField);
  const [open, setOpen] = useState(false);
  const map = field.enumMap ?? {};

  return (
    <span className="relative">
      <button
        title={t("protocol.enum")}
        className={
          "rounded p-1 hover:bg-fg/5 " +
          (field.enumMap ? "text-accent" : "text-muted hover:text-fg")
        }
        onClick={() => setOpen((v) => !v)}
      >
        {t("protocol.enumShort")}
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-10 w-64 rounded-lg border border-border bg-elevated p-2 shadow-lg">
          <div className="mb-1 text-[11px] font-medium text-subtle">
            {t("protocol.enumHint")}
          </div>
          <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {Object.entries(map).map(([k, v]) => (
              <div key={k} className="flex items-center gap-1">
                <Input
                  className="h-6 w-16"
                  value={k}
                  readOnly
                />
                <Input
                  className="h-6 flex-1"
                  value={v}
                  onChange={(e) => {
                    const next = { ...map };
                    delete next[k];
                    next[k] = e.target.value;
                    updateField(index, { enumMap: next });
                  }}
                />
                <button
                  className="rounded p-1 text-muted hover:text-danger"
                  onClick={() => {
                    const next = { ...map };
                    delete next[k];
                    updateField(index, { enumMap: Object.keys(next).length ? next : null });
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 w-full"
            onClick={() =>
              updateField(index, {
                enumMap: { ...map, ["0"]: "value" },
              })
            }
          >
            <Plus size={12} /> {t("protocol.addEnum")}
          </Button>
        </div>
      )}
    </span>
  );
}

function LengthFieldEditor({
  draft,
  updateDraft,
}: {
  draft: ProtocolConfig;
  updateDraft: (p: Partial<ProtocolConfig>) => void;
}) {
  const t = useT();
  const lf = draft.lengthField;
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border bg-bg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-[12px] text-muted hover:text-fg"
      >
        <ChevronRight
          size={14}
          className={"shrink-0 text-subtle transition-transform " + (open ? "rotate-90" : "")}
        />
        <span className="font-medium">{t("protocol.lengthField")}</span>
        {lf && <span className="ml-1 text-accent">{t("protocol.configured")}</span>}
      </button>
      {open && (
        <div className="grid grid-cols-3 gap-2 border-t border-border px-2.5 py-2">
          <Field label={t("protocol.colOffset")}>
            <Input
              type="number"
              min={0}
              value={lf?.offset ?? ""}
              placeholder="0"
              onChange={(e) =>
                updateDraft({
                  lengthField: ensureLf(lf, { offset: Number(e.target.value) || 0 }),
                })
              }
            />
          </Field>
          <Field label={t("protocol.colLength")}>
            <Input
              type="number"
              min={1}
              value={lf?.length ?? ""}
              placeholder="1"
              onChange={(e) =>
                updateDraft({
                  lengthField: ensureLf(lf, { length: Math.max(1, Number(e.target.value) || 1) }),
                })
              }
            />
          </Field>
          <Field label={t("protocol.includeSelf")}>
          <Checkbox
            checked={lf?.includeSelf ?? false}
            onChange={(v) =>
              updateDraft({
                lengthField: ensureLf(lf, { includeSelf: v }),
              })
            }
          />
          </Field>
        </div>
      )}
    </div>
  );
}

function ensureLf(
  lf: ProtocolConfig["lengthField"],
  patch: Partial<NonNullable<ProtocolConfig["lengthField"]>>,
): NonNullable<ProtocolConfig["lengthField"]> {
  return { offset: 0, length: 1, includeSelf: false, ...(lf ?? {}), ...patch };
}

// --- Auto-answer rules (P2) ------------------------------------------------

function AutoAnswerBody() {
  const t = useT();
  const rules = useProtocolDesignerStore((s) => s.draft.autoAnswer ?? []);
  const fields = useProtocolDesignerStore((s) => s.draft.fields);
  const updateRule = useProtocolDesignerStore((s) => s.updateRule);
  const removeRule = useProtocolDesignerStore((s) => s.removeRule);
  const addRuleReply = useProtocolDesignerStore((s) => s.addRuleReply);
  const updateRuleReply = useProtocolDesignerStore((s) => s.updateRuleReply);
  const removeRuleReply = useProtocolDesignerStore((s) => s.removeRuleReply);

  if (rules.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-4 text-center text-[12px] text-subtle">
        {t("protocol.noRules")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rules.map((rule, ri) => {
        const title = `${t("protocol.when")} ${rule.whenField} == ${rule.whenValue}`;
        return (
          <CollapsibleSection
            key={ri}
            title={title}
            defaultOpen={false}
            right={
              <button
                title={t("protocol.delete")}
                className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
                onClick={() => removeRule(ri)}
              >
                <Trash2 size={13} />
              </button>
            }
          >
            <div className="rounded-lg border border-border bg-bg p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <Switch
                  checked={rule.enabled ?? true}
                  onChange={(v) => updateRule(ri, { enabled: v })}
                />
                <span className="text-[11px] text-subtle">{t("protocol.when")}</span>
                <Select
                  className="h-7 w-32"
                  value={rule.whenField}
                  onChange={(e) => updateRule(ri, { whenField: e.target.value })}
                >
                  {fields.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.displayName || f.name}
                    </option>
                  ))}
                </Select>
                <span className="text-[11px] text-subtle">==</span>
                <Input
                  className="h-7 w-20"
                  type="number"
                  value={rule.whenValue}
                  onChange={(e) => updateRule(ri, { whenValue: Number(e.target.value) || 0 })}
                />
              </div>

              <div className="mt-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wide text-subtle">
                    {t("protocol.reply")}
                  </span>
                  <button
                    className="rounded p-1 text-muted hover:bg-fg/5 hover:text-fg"
                    onClick={() => addRuleReply(ri)}
                  >
                    <Plus size={12} />
                  </button>
                </div>
                {rule.reply.map((rep, rj) => (
                  <div key={rj} className="mb-1 flex items-center gap-1">
                    <Select
                      className="h-7 w-32"
                      value={rep.name}
                      onChange={(e) => updateRuleReply(ri, rj, { name: e.target.value })}
                    >
                      {fields.map((f) => (
                        <option key={f.name} value={f.name}>
                          {f.displayName || f.name}
                        </option>
                      ))}
                    </Select>
                    <Input
                      className="h-7 w-24"
                      value={typeof rep.value === "number" ? rep.value : String(rep.value ?? "")}
                      onChange={(e) =>
                        updateRuleReply(ri, rj, {
                          value: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                    />
                    <button
                      className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
                      onClick={() => removeRuleReply(ri, rj)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </CollapsibleSection>
        );
      })}
    </div>
  );
}

/** Lightweight collapsible panel used to tidy the editor's long sections. The
 *  header (title + optional `right` controls) toggles open/closed; clicks on
 *  `right` are isolated so e.g. an "add" button doesn't toggle the panel. */
function CollapsibleSection({
  title,
  right,
  defaultOpen = true,
  children,
}: {
  title: string;
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-4">
      <div
        className="mb-2 flex cursor-pointer select-none items-center justify-between"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-1.5">
          <ChevronRight
            size={14}
            className={
              "text-subtle transition-transform " + (open ? "rotate-90" : "")
            }
          />
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
            {title}
          </h3>
        </div>
        {right && (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {right}
          </div>
        )}
      </div>
      {open && <div>{children}</div>}
    </section>
  );
}

/** Render the head/tail value for editing. Accepts either a display string
 *  (kept as-is so the user's spaces/separators are preserved) or a byte array
 *  (rendered back to "AA BB" form), and falls back to "" for null/empty. */
function normalizeHexDisplay(v: string | number[] | null | undefined): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    return v.map((b) => (b & 0xff).toString(16).padStart(2, "0").toUpperCase()).join(" ");
  }
  return "";
}
