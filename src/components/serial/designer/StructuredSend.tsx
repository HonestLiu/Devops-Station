import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

import { useProtocolDesignerStore } from "@/store/useProtocolDesignerStore";
import { useT } from "@/i18n";
import { Button, Field, Input, Select } from "@/components/ui";
import { bytesToHex, base64ToBytes } from "@/lib/utils";
import { serial, ble } from "@/lib/api";
import { useTabsStore } from "@/store/useTabsStore";
import type { FieldDef, FieldValue } from "@/lib/types";

/**
 * Structured send: fill in each field's value, encode into a wire frame via the
 * backend, and either ship it to the loopback channel (offline test) or write
 * it to the bound live session. The encoded hex preview updates live.
 */
export function StructuredSend({
  open,
  onToggleOpen,
}: {
  open: boolean;
  onToggleOpen: () => void;
}) {
  const t = useT();
  const {
    draft,
    mode,
    targetSession,
    loopbackId,
    openLoopback,
    loopbackSend,
    encode,
  } = useProtocolDesignerStore();

  const [values, setValues] = useState<Record<string, string>>({});
  const [encoded, setEncoded] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Reset value inputs when the field set changes.
  useEffect(() => {
    setValues({});
    setEncoded("");
  }, [draft.id, draft.fields]);

  const setVal = (name: string, v: string) =>
    setValues((prev) => ({ ...prev, [name]: v }));

  const doEncode = async () => {
    setError(null);
    try {
      const fv: FieldValue[] = draft.fields.map((f) => ({
        name: f.name,
        value: coerce(f, values[f.name] ?? ""),
      }));
      const b64 = await encode(fv);
      setEncoded(b64);
      return b64;
    } catch (e) {
      setError((e as Error).message);
      setEncoded("");
      return null;
    }
  };

  const handleSend = async () => {
    const b64 = await doEncode();
    if (!b64) return;
    setSent(false);
    try {
      if (mode === "loopback") {
        // The loopback channel must be open to receive the frame. Open it on
        // demand (it auto-sends a sample) so the send button works without a
        // prior manual toggle, then push the encoded frame.
        if (!loopbackId) await openLoopback();
        await loopbackSend(b64);
      } else if (targetSession) {
        const isBle = useTabsStoreSessionIsBle(targetSession);
        if (isBle) await ble.write(targetSession, b64);
        else await serial.write(targetSession, b64);
      } else {
        setError(t("protocol.noTargetSelected"));
        return;
      }
      setSent(true);
      setTimeout(() => setSent(false), 1500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

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
        {t("protocol.send")}
      </button>
      {open && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
          {draft.fields.length === 0 ? (
            <div className="text-[12px] text-subtle">{t("protocol.noFieldsHint")}</div>
          ) : (
            draft.fields.map((f) => (
              <Field key={f.name} label={`${f.displayName || f.name}${f.unit ? ` (${f.unit})` : ""}`}>
                <Input
                  className="font-mono"
                  value={values[f.name] ?? ""}
                  placeholder={defaultPlaceholder(f)}
                  onChange={(e) => setVal(f.name, e.target.value)}
                />
              </Field>
            ))
          )}

          <div className="flex gap-1">
            <Button size="sm" variant="secondary" onClick={() => void doEncode()}>
              {t("protocol.encode")}
            </Button>
            <Button size="sm" variant="primary" onClick={() => void handleSend()}>
              {t("protocol.sendBtn")}
            </Button>
          </div>

          {encoded && (
            <div className="rounded-lg border border-border bg-bg px-2.5 py-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-subtle">
                {t("protocol.encoded")}
              </div>
              <div className="break-all font-mono text-[12px] text-fg">
                {bytesToHex(base64ToBytes(encoded))}
              </div>
            </div>
          )}

          {error && <div className="text-[11px] text-danger">{error}</div>}
          {sent && <div className="text-[11px] text-success">{t("protocol.sentOk")}</div>}
        </div>
      )}
    </div>
  );
}

function defaultPlaceholder(f: FieldDef): string {
  switch (f.dataType) {
    case "asciistring":
      return "abc";
    case "hexstring":
      return "AABB";
    case "float32":
    case "float64":
      return "0.0";
    default:
      return "0";
  }
}

function coerce(f: FieldDef, raw: string): unknown {
  if (f.dataType === "asciistring") return raw;
  if (f.dataType === "hexstring") return raw;
  if (f.dataType === "float32" || f.dataType === "float64") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

// Small helper to check session kind without subscribing to the tabs store.
function useTabsStoreSessionIsBle(sessionId: string): boolean {
  const kind = useTabsStore
    .getState()
    .tabs.find((t) => t.sessionId === sessionId)?.kind;
  return kind === "ble";
}
