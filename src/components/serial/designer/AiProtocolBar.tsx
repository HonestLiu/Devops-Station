import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Loader2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Button, Input } from "@/components/ui";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { useProtocolDesignerStore } from "@/store/useProtocolDesignerStore";
import { completeText } from "@/ai/client";
import { currentProvider, hasAiConfig } from "@/ai/useAiStore";
import {
  parseAiJson,
  protocolSystemPrompt,
  sanitizeProtocol,
} from "@/lib/protocolAi";
import type { ProtocolConfig } from "@/lib/types";

/**
 * Inline AI bar for the protocol designer. The user describes a protocol in
 * natural language; the LLM returns a `ProtocolConfig` JSON which we validate
 * and preview. Nothing is written to the draft until the user confirms
 * ("Apply & fill"), so existing work is never silently overwritten.
 */
export function AiProtocolBar() {
  const t = useT();
  const [requirement, setRequirement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ProtocolConfig | null>(null);
  const [applied, setApplied] = useState(false);

  const generate = async () => {
    const req = requirement.trim();
    if (!req || !hasAiConfig() || busy) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    setApplied(false);
    try {
      const { text, error: err } = await completeText({
        provider: currentProvider(),
        messages: [
          { role: "system", content: protocolSystemPrompt() },
          { role: "user", content: req },
        ],
      });
      if (err) {
        setError(t("protocol.aiGenError", { err }));
        return;
      }
      const raw = parseAiJson(text);
      const cfg = sanitizeProtocol(raw);
      if (!cfg) {
        setError(t("protocol.aiParseError"));
        return;
      }
      setPreview(cfg);
    } catch (e) {
      setError(t("protocol.aiGenError", { err: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    if (!preview) return;
    try {
      const store = useProtocolDesignerStore.getState();
      // Fill the protocol that is currently open in the editor (the one the
      // user typed the prompt into) — never spawn a separate project.
      // updateDraft merges, so we keep the existing id / selectedId and only
      // overwrite the fields the AI produced. For a brand-new unsaved draft
      // the autosave will persist it as that same draft (not a duplicate).
      store.updateDraft({
        id: store.draft.id,
        name: preview.name,
        description: preview.description,
        doc: preview.doc,
        head: preview.head,
        tail: preview.tail,
        endian: preview.endian,
        timeoutMs: preview.timeoutMs,
        checksum: preview.checksum,
        lengthField: preview.lengthField,
        fields: preview.fields,
        autoAnswer: preview.autoAnswer,
      });
      setApplied(true);
    } catch (e) {
      setError(t("protocol.aiApplyError", { err: (e as Error).message }));
    } finally {
      setPreview(null);
      setRequirement("");
    }
  };

  const discard = () => {
    setPreview(null);
    setError(null);
  };

  return (
    <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 p-2.5">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-accent">
        <Sparkles size={13} />
        {t("protocol.aiBar")}
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
          placeholder={t("protocol.aiRequirementPh")}
          className="select-text flex-1"
          disabled={busy}
          onKeyDown={(e) => {
            if (e.key === "Enter") void generate();
          }}
        />
        <Button
          variant="primary"
          size="sm"
          className="shrink-0"
          disabled={busy || !hasAiConfig() || !requirement.trim()}
          onClick={() => void generate()}
          title={t("protocol.aiGenerate")}
        >
          {busy ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Sparkles size={13} />
          )}
          {busy ? t("protocol.aiGenerating") : t("protocol.aiGenerate")}
        </Button>
      </div>

      {/* AI not configured: show the setup hint instead of a dead button. */}
      {!hasAiConfig() && (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-2 py-1.5 text-[12px]">
          <AlertTriangle size={13} className="shrink-0 text-warning" />
          <span className="truncate">{t("ai.needSetup")}</span>
          <button
            onClick={() => useAppStore.getState().setPage("settings")}
            className="ml-auto shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-medium text-accent-fg transition hover:opacity-90"
          >
            {t("ai.goSettings")}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-danger">
          <AlertTriangle size={12} /> {error}
        </p>
      )}

      {applied && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-success">
          <Check size={12} /> {t("protocol.aiApplied")}
        </p>
      )}

      {/* Preview card — shown before applying. */}
      {preview && (
        <div className="mt-2 rounded-md border border-border bg-bg p-2.5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-semibold text-fg">
              {t("protocol.aiPreviewTitle")}
            </span>
            <button
              onClick={discard}
              className="text-subtle transition hover:text-fg"
              title={t("protocol.aiDiscard")}
            >
              <X size={14} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] sm:grid-cols-3">
            <Meta label={t("protocol.name")} value={preview.name} />
            <Meta
              label={t("protocol.head")}
              value={
                preview.head == null ? "—" : String(preview.head) || "—"
              }
              mono
            />
            <Meta
              label={t("protocol.tail")}
              value={
                preview.tail == null ? "—" : String(preview.tail) || "—"
              }
              mono
            />
            <Meta
              label={t("protocol.endian")}
              value={
                preview.endian === "little"
                  ? t("protocol.littleEndian")
                  : t("protocol.bigEndian")
              }
            />
            <Meta
              label={t("protocol.checksum")}
              value={
                preview.checksum
                  ? t(`protocol.checksum_${preview.checksum.algo}`)
                  : t("protocol.checksum_none")
              }
            />
            <Meta label={t("protocol.aiFieldCount")} value={String(preview.fields.length)} />
          </div>

          {preview.fields.length > 0 && (
            <div className="mt-2 overflow-hidden rounded border border-border">
              <table className="w-full text-[11px]">
                <thead className="bg-elevated text-subtle">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium">
                      {t("protocol.colName")}
                    </th>
                    <th className="px-2 py-1 text-left font-medium">
                      {t("protocol.colType")}
                    </th>
                    <th className="px-2 py-1 text-right font-medium">
                      {t("protocol.colOffset")}
                    </th>
                    <th className="px-2 py-1 text-right font-medium">
                      {t("protocol.colLength")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.fields.map((f, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-2 py-1 font-mono text-fg">{f.name}</td>
                      <td className="px-2 py-1 text-muted">{f.dataType}</td>
                      <td className="px-2 py-1 text-right font-mono text-muted">
                        {f.offset}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-muted">
                        {f.length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.autoAnswer && preview.autoAnswer.length > 0 && (
            <p className="mt-2 text-[11px] text-subtle">
              {t("protocol.autoAnswer")} × {preview.autoAnswer.length}
            </p>
          )}

          <div className="mt-2.5 flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={discard}>
              <Trash2 size={13} /> {t("protocol.aiDiscard")}
            </Button>
            <Button variant="primary" size="sm" onClick={apply}>
              <Check size={13} /> {t("protocol.aiApply")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Meta({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-subtle">{label}</span>
      <span className={"text-fg" + (mono ? " font-mono" : "")}>{value}</span>
    </div>
  );
}
