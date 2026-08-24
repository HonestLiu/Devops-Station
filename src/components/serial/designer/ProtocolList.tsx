import { useEffect, useRef, useState } from "react";
import { Check, Copy, FilePlus2, Loader2, Pencil, Trash2, Upload, Download, X } from "lucide-react";

import { useProtocolDesignerStore } from "@/store/useProtocolDesignerStore";
import { useTabsStore } from "@/store/useTabsStore";
import { useT } from "@/i18n";
import { Button, Field, Input, Select } from "@/components/ui";
import { formatMtime } from "@/lib/utils";
import { serial, ble, protocol, localFs } from "@/lib/api";
import { save } from "@tauri-apps/plugin-dialog";
import type { StreamChunk, ProtocolConfig } from "@/lib/types";

/**
 * Left rail of the Protocol Designer: the saved-protocol list plus the
 * create / duplicate / delete controls and the live-vs-loopback mode switch.
 * When `mode === "live"`, a target session dropdown lets the designer bind to
 * a connected serial/ble tab so its incoming bytes get parsed in real time.
 */
export function ProtocolList({ dir }: { dir: "rx" | "tx" }) {
  const t = useT();
  const {
    list,
    selectedId,
    select,
    newDraft,
    remove,
    duplicateProtocol,
    importProtocol,
    mode,
    setMode,
    targetSession,
    setTargetSession,
    saving,
    dirty,
    lastSavedAt,
    autoSave,
  } = useProtocolDesignerStore();

  const tabs = useTabsStore((s) => s.tabs);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  // Connected serial / ble sessions the designer can bind to. The designer and
  // basic-serial module tabs are also `kind: "serial"`, so exclude anything that
  // carries a `serialModule` (those aren't real device connections).
  const sessions = tabs.filter(
    (tb) =>
      ((tb.kind === "serial" && !tb.serialModule) || tb.kind === "ble") &&
      tb.status === "connected" &&
      tb.sessionId,
  );

  useEffect(() => {
    void useProtocolDesignerStore.getState().refreshList();
  }, []);

  // --- live session feed wiring -------------------------------------------
  useEffect(() => {
    if (mode !== "live" || !targetSession) return;
    const isBle =
      useTabsStore.getState().tabs.find((x) => x.sessionId === targetSession)?.kind === "ble";
    let unlisten: (() => void) | undefined;
    const bind = isBle ? ble : serial;
    const done = bind
      .onData(targetSession, (chunk: StreamChunk) => {
        void onLiveChunk(chunk);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      void done.then(() => unlisten?.());
    };

    async function onLiveChunk(chunk: StreamChunk) {
      const st = useProtocolDesignerStore.getState();
      try {
        const frames = await protocol.parse(st.draft.id, chunk.data, st.draft);
        for (const f of frames) st.pushLiveFrame(f);
      } catch {
        /* ignore parse errors from partial frames */
      }
    }
  }, [mode, targetSession, tabs]);

  const handleDelete = async (id: string) => {
    setBusy(true);
    try {
      await remove(id);
    } finally {
      setBusy(false);
      setConfirmDel(null);
    }
  };

  const handleDuplicate = async (id: string, name: string) => {
    setBusy(true);
    try {
      await duplicateProtocol(id, `${name} (copy)`);
    } finally {
      setBusy(false);
    }
  };

  // --- export / import a whole protocol project as JSON --------------------
  const fileRef = useRef<HTMLInputElement>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Per-item export animation state: which protocol id is currently exporting.
  const [busyExportId, setBusyExportId] = useState<string | null>(null);
  const [doneExportId, setDoneExportId] = useState<string | null>(null);
  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2500);
  };

  const downloadJson = (filename: string, data: unknown) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExport = async (id: string, name: string) => {
    if (busyExportId) return;
    setBusyExportId(id);
    setDoneExportId(null);
    try {
      const cfg = await protocol.load(id);
      const json = JSON.stringify(cfg, null, 2);
      const base = `${name || "protocol"}.json`;
      let wrote = false;
      try {
        // Native save dialog: lets the user pick a target directory + filename.
        const target = await save({
          title: t("protocol.exportJson"),
          defaultPath: base,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (target) {
          await localFs.writeText(target, json);
          wrote = true;
        }
      } catch {
        // Outside the desktop shell (web preview) fall back to a download.
        wrote = false;
      }
      if (!wrote) {
        downloadJson(base, cfg);
      }
      flash(t("protocol.exportJsonDone"));
      setDoneExportId(id);
      window.setTimeout(() => setDoneExportId(null), 1500);
    } catch (e) {
      flash(t("protocol.importError", { err: (e as Error).message }));
    } finally {
      setBusyExportId(null);
    }
  };

  const handleImportFile = async (file: File) => {
    setBusy(true);
    try {
      const text = await file.text();
      const saved = await importProtocol(text);
      flash(t("protocol.importDone", { name: saved.name }));
    } catch (e) {
      const msg = (e as Error).message;
      flash(
        msg === "bad-protocol-json"
          ? t("protocol.badFile")
          : t("protocol.importError", { err: msg }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Mode switch */}
      <div className="flex gap-1 border-b border-border/60 p-2">
        {(["loopback", "live"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={
              "flex-1 rounded-lg px-2 py-1.5 text-[12px] font-medium transition-colors " +
              (mode === m
                ? "bg-accent text-accent-fg"
                : "bg-hover text-muted hover:text-fg")
            }
          >
            {m === "loopback" ? t("protocol.modeLoopback") : t("protocol.modeLive")}
          </button>
        ))}
      </div>

      {mode === "live" && (
        <div className="border-b border-border/60 p-2">
          <Field label={t("protocol.targetSession")}>
            <Select
              value={targetSession ?? ""}
              onChange={(e) => setTargetSession(e.target.value || null)}
            >
              <option value="">{t("protocol.noTarget")}</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.sessionId}>
                  {s.title} · {s.sessionId}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-1 p-2">
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          onClick={() => newDraft()}
          disabled={busy}
        >
          <FilePlus2 size={14} /> {t("protocol.new")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          title={t("protocol.importHint")}
        >
          <Download size={14} /> {t("protocol.import")}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImportFile(f);
            e.target.value = "";
          }}
        />
      </div>

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {list.length === 0 ? (
          <div className="px-2 py-6 text-center text-[12px] text-subtle">
            {t("protocol.empty")}
          </div>
        ) : (
          <ul className="flex flex-col gap-1">
            {list.map((p) => (
              <li
                key={p.id}
                onClick={() => void select(p.id)}
                className={
                  "group cursor-pointer rounded-lg border px-2.5 py-2 transition-colors " +
                  (selectedId === p.id
                    ? "border-accent/50 bg-accent/10"
                    : "border-border bg-surface hover:bg-hover")
                }
              >
                <div className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-fg">{p.name}</div>
                    <div className="text-[10px] text-subtle">
                      {formatMtime(p.updatedAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      title={t("protocol.exportJson")}
                      className="rounded p-1 text-muted hover:bg-fg/5 hover:text-fg disabled:opacity-50"
                      disabled={busyExportId === p.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleExport(p.id, p.name);
                      }}
                    >
                      {busyExportId === p.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : doneExportId === p.id ? (
                        <Check size={13} className="text-success" />
                      ) : (
                        <Upload size={13} />
                      )}
                    </button>
                    <button
                      title={t("protocol.duplicate")}
                      className="rounded p-1 text-muted hover:bg-fg/5 hover:text-fg"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDuplicate(p.id, p.name);
                      }}
                    >
                      <Copy size={13} />
                    </button>
                    {confirmDel === p.id ? (
                      <span className="flex items-center gap-0.5">
                        <button
                          title={t("protocol.confirm")}
                          className="rounded p-1 text-danger hover:bg-danger/10"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDelete(p.id);
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                        <button
                          title={t("protocol.cancel")}
                          className="rounded p-1 text-muted hover:bg-fg/5"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDel(null);
                          }}
                        >
                          <X size={13} />
                        </button>
                      </span>
                    ) : (
                      <button
                        title={t("protocol.delete")}
                        className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDel(p.id);
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
                {p.description && (
                  <div className="mt-0.5 line-clamp-1 text-[11px] text-muted">
                    {p.description}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* editing + auto-save indicator */}
      <div className="flex items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-[10px] text-subtle">
        {selectedId ? (
          <span className="flex items-center gap-1">
            <Pencil size={11} className="shrink-0" /> {t("protocol.editing")}
          </span>
        ) : (
          t("protocol.editingNew")
        )}
        <span className="ml-auto flex items-center gap-1">
          {!autoSave ? (
            t("protocol.autoSaveOff")
          ) : saving ? (
            <>
              <Loader2 size={11} className="shrink-0 animate-spin" /> {t("protocol.autoSaving")}
            </>
          ) : dirty ? (
            t("protocol.autoPending")
          ) : lastSavedAt ? (
            <>
              <Check size={11} className="shrink-0 text-success" /> {t("protocol.autoSaved")}
            </>
          ) : null}
        </span>
      </div>
      {/* `dir` is reserved for future tx/rx split; keep referenced. */}
      <span className="hidden">{dir}</span>

      {toast && (
        <div className="border-t border-border/60 px-3 py-1.5 text-[11px] text-success">
          {toast}
        </div>
      )}
    </div>
  );
}
