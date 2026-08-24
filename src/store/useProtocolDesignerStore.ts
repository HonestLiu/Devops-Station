import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { protocol } from "@/lib/api";
import { hexToBytes, bytesToBase64 } from "@/lib/utils";
import type {
  AutoAnswerRule,
  FieldDef,
  FieldValue,
  ParsedFrame,
  ProtocolConfig,
  ProtocolSummary,
} from "@/lib/types";

/** A blank field — used by the "add field" button. */
export function emptyField(): FieldDef {
  return {
    name: "",
    displayName: "",
    offset: 0,
    length: 1,
    dataType: "uint8",
    scale: null,
    unit: null,
    enumMap: null,
    condition: null,
  };
}

/** A minimal blank protocol — used by the "new protocol" button. */
export function emptyProtocol(name = "Untitled"): ProtocolConfig {
  return {
    id: "",
    name,
    description: null,
    doc: null,
    head: null,
    tail: null,
    lengthField: null,
    fields: [],
    checksum: null,
    endian: "big",
    timeoutMs: 50,
    autoAnswer: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * A ready-made example protocol shipped with the designer. Seeded once into
 * the store when the user has no protocols yet, so the workbench is never
 * empty on first open. It exercises every major feature: frame head/tail,
 * big-endian, a CRC-16/MODBUS checksum, mixed field types (command with an
 * enum map, a scaled int16 temperature, a float32 humidity, a hex serial),
 * and one auto-answer rule that loops back a reply when `cmd == 2`.
 */
export function demoProtocol(): ProtocolConfig {
  return {
    id: "",
    name: "传感器帧示例",
    description: "自动生成的示例协议：演示帧头/帧尾、校验、多类型字段与自动应答。",
    doc:
      "# 传感器帧示例\n\n" +
      "本示例演示如何用一个**固定帧头/帧尾 + 校验和**的协议上报温湿度与环境数据。\n\n" +
      "## 帧结构\n\n" +
      "| 字段 | 说明 | 类型 |\n" +
      "| --- | --- | --- |\n" +
      "| addr | 设备地址 | uint8 |\n" +
      "| cmd | 命令字（1=查询，2=写入） | uint8 |\n" +
      "| temperature | 温度（×0.1 °C） | int16 |\n" +
      "| humidity | 湿度 | float32 |\n" +
      "| serial | 设备序列号 | hex |\n\n" +
      "## 自动应答\n\n" +
      "当收到 `cmd == 2`（写入）时，设备会回送一帧确认（`cmd == 1`），字段清零。\n\n" +
      "## 注意事项\n\n" +
      "- 校验算法为 `CRC-16/MODBUS`，覆盖从帧起始到校验字段前的全部字节。\n" +
      "- 帧以 `AA BB` 开头，以 `0D 0A`（回车换行）结尾。\n",
    head: "AA BB",
    tail: "0D 0A",
    lengthField: null,
    endian: "big",
    timeoutMs: 50,
    checksum: { algo: "crc16modbus", start: 0, end: null },
    fields: [
      {
        name: "addr",
        displayName: "设备地址",
        offset: 0,
        length: 1,
        dataType: "uint8",
        scale: null,
        unit: null,
        enumMap: { "1": "节点A", "2": "节点B" },
        condition: null,
      },
      {
        name: "cmd",
        displayName: "命令字",
        offset: 1,
        length: 1,
        dataType: "uint8",
        scale: null,
        unit: null,
        enumMap: { "1": "查询", "2": "写入" },
        condition: null,
      },
      {
        name: "temperature",
        displayName: "温度",
        offset: 2,
        length: 2,
        dataType: "int16",
        scale: 0.1,
        unit: "°C",
        enumMap: null,
        condition: null,
      },
      {
        name: "humidity",
        displayName: "湿度",
        offset: 4,
        length: 4,
        dataType: "float32",
        scale: null,
        unit: "%RH",
        enumMap: null,
        condition: null,
      },
      {
        name: "serial",
        displayName: "序列号",
        offset: 8,
        length: 4,
        dataType: "hexstring",
        scale: null,
        unit: null,
        enumMap: null,
        condition: null,
      },
    ],
    autoAnswer: [
      {
        enabled: true,
        note: "收到写入命令时回送确认帧",
        whenField: "cmd",
        whenValue: 2,
        reply: [
          { name: "addr", value: 0 },
          { name: "cmd", value: 1 },
          { name: "temperature", value: 0 },
          { name: "humidity", value: 0 },
          { name: "serial", value: "00000000" },
        ],
      },
    ],
    createdAt: 0,
    updatedAt: 0,
  };
}

/** What the workspace is pointed at: live session feed or offline loopback. */
export type DesignerMode = "live" | "loopback";

/**
 * Convert the frontend-facing draft (where `head` / `tail` are hex *strings*)
 * into the wire representation the backend expects (where they are byte arrays).
 * The Rust `ProtocolConfig` stores them as `Vec<u8>`; converting here keeps the
 * editor's loose hex input while satisfying serde on the backend. Extra fields
 * (scale/unit/enumMap/condition) are passed through as-is.
 */
function toWireConfig(draft: ProtocolConfig): ProtocolConfig {
  const hexToBytes = (s: string | number[] | null | undefined): number[] | null => {
    if (s == null) return null;
    const txt = typeof s === "string" ? s : "";
    const cleaned = txt.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
    if (cleaned.length === 0) return null;
    const padded = cleaned.length % 2 ? `0${cleaned}` : cleaned;
    const out: number[] = [];
    for (let i = 0; i < padded.length; i += 2) {
      out.push(parseInt(padded.slice(i, i + 2), 16));
    }
    return out;
  };
  return {
    ...draft,
    head: hexToBytes(draft.head),
    tail: hexToBytes(draft.tail),
  };
}

/**
 * Inverse of `toWireConfig`: normalize a config loaded from the backend
 * (where `head` / `tail` arrive as byte arrays) into the editor's hex-string
 * form so the inputs render correctly.
 */
function fromWireConfig(cfg: ProtocolConfig): ProtocolConfig {
  const bytesToHex = (v: string | number[] | null | undefined): string | null => {
    if (v == null) return null;
    if (typeof v === "string") return v;
    return v.map((b) => (b & 0xff).toString(16).padStart(2, "0").toUpperCase()).join(" ");
  };
  return {
    ...cfg,
    head: bytesToHex(cfg.head),
    tail: bytesToHex(cfg.tail),
  };
}

interface DesignerState {
  // --- list / selection ---
  /** All saved protocols (summaries). */
  list: ProtocolSummary[];
  /** Currently selected protocol id (null = editing a brand-new draft). */
  selectedId: string | null;
  /** The draft being edited (always a full config, even for a new protocol). */
  draft: ProtocolConfig;

  // --- mode / target ---
  /** Whether frames come from a live serial/ble session or an offline loopback. */
  mode: DesignerMode;
  /** Target session id when `mode === "live"` (a connected serial/ble tab). */
  targetSession: string | null;
  /** Loopback channel id (== selectedId when loopback is active). */
  loopbackId: string | null;

  // --- results ---
  /** Parsed frames from loopback (most recent first). */
  loopbackFrames: ParsedFrame[];
  /** Parsed frames from the live session feed (most recent first). */
  liveFrames: ParsedFrame[];
  /** Sample-hex preview frames (offline, from the editor's sample input). */
  sampleFrames: ParsedFrame[];

  // --- ui ---
  /** Field name selected in the parse/Hex view for cross-highlighting. */
  selectedField: string | null;
  /** When false, only the latest frame is kept (no accumulation). */
  accumulate: boolean;

  // --- structured send (persisted per protocol so values survive leaving the
  //     module / switching protocols and come back on return) ---
  /** Per-protocol field values for the structured-send form. */
  sendValues: Record<string, Record<string, string>>;
  /** Per-protocol numeric base (hex/dec) overrides for the structured-send form. */
  sendBases: Record<string, Record<string, "hex" | "dec">>;

  // --- auto-save ---
  /** Auto-save is on by default; every edit is persisted debounced. */
  autoSave: boolean;
  /** True while there are unsaved edits (set by editing actions). */
  dirty: boolean;
  /** True while a save is in flight. */
  saving: boolean;
  /** Epoch ms of the last successful save (for the status indicator). */
  lastSavedAt: number | null;

  // --- actions ---
  /** Debounced auto-save trigger (no-op when auto-save is off). */
  scheduleSave: () => void;
  refreshList: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  newDraft: (name?: string) => void;
  updateDraft: (patch: Partial<ProtocolConfig>) => void;
  updateField: (idx: number, patch: Partial<FieldDef>) => void;
  addField: () => void;
  removeField: (idx: number) => void;
  duplicateField: (idx: number) => void;
  moveField: (idx: number, dir: -1 | 1) => void;

  addRule: () => void;
  updateRule: (idx: number, patch: Partial<AutoAnswerRule>) => void;
  removeRule: (idx: number) => void;
  addRuleReply: (idx: number) => void;
  updateRuleReply: (
    ruleIdx: number,
    replyIdx: number,
    patch: Partial<FieldValue>,
  ) => void;
  removeRuleReply: (ruleIdx: number, replyIdx: number) => void;

  setMode: (mode: DesignerMode) => void;
  setTargetSession: (sid: string | null) => void;

  save: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  duplicateProtocol: (id: string, newName: string) => Promise<void>;

  /** Import a protocol design project from a JSON string (exported via
   *  `exportProtocolJson`). The `id` is stripped so the backend assigns a
   *  fresh UUID, avoiding collisions with the source project. */
  importProtocol: (json: string) => Promise<ProtocolConfig>;

  /** Preview-parse a sample hex string against the current draft. */
  previewSample: (hex: string) => Promise<void>;
  /** Encode field values into a wire frame (base64). */
  encode: (fields: FieldValue[]) => Promise<string>;

  /** Loopback: open a channel for the draft and start receiving frames. */
  openLoopback: () => Promise<void>;
  closeLoopback: () => Promise<void>;
  loopbackSend: (rawBase64: string) => Promise<void>;
  /** Push the current draft into the running loopback channel. */
  reloadLoopback: () => Promise<void>;

  /** Append a parsed frame sourced from the live session feed. */
  pushLiveFrame: (frame: ParsedFrame) => void;
  selectField: (name: string | null) => void;

  /** Toggle whether parsed frames accumulate or only the latest is kept. */
  toggleAccumulate: () => void;
  /** Clear all parsed frames (loopback + live). */
  clearFrames: () => void;

  /** Set a structured-send field value for the current protocol. */
  setSendValue: (name: string, value: string) => void;
  /** Set the numeric base (hex/dec) for a structured-send field. */
  setSendBase: (name: string, base: "hex" | "dec") => void;
  /** Seed example values for any field of the current protocol that has none
   *  yet (used right after AI generation so the form is test-ready). */
  seedSendExamples: (fields: FieldDef[]) => void;
}

const MAX_FRAMES = 200;

/** Guards the one-time demo seeding so rapid refreshes don't duplicate it. */
let demoSeeded = false;

/** Active loopback frame-event unsubscribe handle (owned by the store so the
 *  subscription is established before any frame is sent, avoiding a React
 *  effect-timing race where the auto sample frame could be missed). */
let loopbackUnsub: UnlistenFn | null = null;

/** Debounce timer for the auto-save trigger. */
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** A plausible default value for a field, used to synthesise a loopback
 *  sample frame when a channel is opened. Mirrors the encoder's input shape
 *  (numbers for numeric/bit types, raw strings for ascii/hex). */
function sampleValue(f: FieldDef): unknown {
  switch (f.dataType) {
    case "asciistring":
      return "demo";
    case "hexstring":
      return "DEADBEEF".slice(0, Math.max(2, f.length * 2)).toUpperCase();
    case "float32":
    case "float64":
      return 1.0;
    default:
      return 1;
  }
}

/** Example string for a structured-send field, matching the form's default
 *  hex base. Prefers the first enum value so auto-answer rules are easy to
 *  exercise; otherwise a small length-padded positive number or a literal. */
function exampleSendValue(f: FieldDef): string {
  switch (f.dataType) {
    case "asciistring":
      return "demo";
    case "hexstring":
      return "DEADBEEF".slice(0, Math.max(2, f.length * 2)).toUpperCase();
    case "float32":
    case "float64":
      return "1.0";
    default: {
      if (f.enumMap && Object.keys(f.enumMap).length) {
        const first = Object.keys(f.enumMap)[0];
        const n = Number(first);
        if (Number.isFinite(n)) return n.toString(16).toUpperCase().padStart(2, "0");
      }
      const width = Math.max(2, f.length * 2);
      return (1).toString(16).toUpperCase().padStart(width, "0");
    }
  }
}

export const useProtocolDesignerStore = create<DesignerState>((set, get) => ({
  list: [],
  selectedId: null,
  draft: emptyProtocol(),

  mode: "loopback",
  targetSession: null,
  loopbackId: null,

  loopbackFrames: [],
  liveFrames: [],
  sampleFrames: [],

  selectedField: null,
  accumulate: true,

  sendValues: {},
  sendBases: {},

  autoSave: true,
  dirty: false,
  saving: false,
  lastSavedAt: null,

  refreshList: async () => {
    const list = await protocol.list();
    set({ list });

    // First run with no protocols: drop in the bundled example so the
    // workbench is never empty. Seed once per session; the saved protocol
    // shows up on the next refresh.
    if (list.length === 0 && !demoSeeded) {
      demoSeeded = true;
      try {
        const saved = await protocol.save(toWireConfig(demoProtocol()));
        const refreshed = await protocol.list();
        set({ list: refreshed });
        // Auto-select the demo so the editor is pre-filled with a real id and
        // the loopback channel can open without an extra save round-trip.
        const loaded = await protocol.load(saved.id);
        set({ selectedId: saved.id, draft: fromWireConfig(loaded), dirty: false });
      } catch {
        demoSeeded = false; // allow a retry on the next refresh
      }
    }
  },

  select: async (id) => {
    if (id === null) {
      set({ selectedId: null, draft: emptyProtocol(), dirty: false });
      return;
    }
    const draft = await protocol.load(id);
    set({ selectedId: id, draft: fromWireConfig(draft), dirty: false });
  },

  newDraft: (name) => {
    set({ selectedId: null, draft: emptyProtocol(name), dirty: false });
  },

  updateDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch }, dirty: true })),

  updateField: (idx, patch) =>
    set((s) => {
      const fields = s.draft.fields.slice();
      fields[idx] = { ...fields[idx], ...patch };
      return { draft: { ...s.draft, fields }, dirty: true };
    }),

  addField: () =>
    set((s) => {
      const fields = [...s.draft.fields, { ...emptyField() }];
      // Default the new field's offset to the end of the previous one.
      const prev = s.draft.fields[s.draft.fields.length - 1];
      if (prev) fields[fields.length - 1].offset = prev.offset + prev.length;
      return { draft: { ...s.draft, fields }, dirty: true };
    }),

  removeField: (idx) =>
    set((s) => ({
      draft: { ...s.draft, fields: s.draft.fields.filter((_, i) => i !== idx) },
      dirty: true,
    })),

  duplicateField: (idx) =>
    set((s) => {
      const fields = s.draft.fields.slice();
      const copy = { ...fields[idx], name: `${fields[idx].name}_copy` };
      fields.splice(idx + 1, 0, copy);
      return { draft: { ...s.draft, fields }, dirty: true };
    }),

  moveField: (idx, dir) =>
    set((s) => {
      const j = idx + dir;
      if (j < 0 || j >= s.draft.fields.length) return s;
      const fields = s.draft.fields.slice();
      [fields[idx], fields[j]] = [fields[j], fields[idx]];
      return { draft: { ...s.draft, fields }, dirty: true };
    }),

  addRule: () =>
    set((s) => {
      const rules = s.draft.autoAnswer ?? [];
      const firstField = s.draft.fields[0]?.name ?? "";
      const next = rules.concat({
        enabled: true,
        note: null,
        whenField: firstField,
        whenValue: 0,
        reply: firstField ? [{ name: firstField, value: 0 }] : [],
      });
      return { draft: { ...s.draft, autoAnswer: next }, dirty: true };
    }),

  updateRule: (idx, patch) =>
    set((s) => {
      const rules = (s.draft.autoAnswer ?? []).slice();
      if (idx < 0 || idx >= rules.length) return s;
      rules[idx] = { ...rules[idx], ...patch };
      return { draft: { ...s.draft, autoAnswer: rules }, dirty: true };
    }),

  removeRule: (idx) =>
    set((s) => {
      const rules = (s.draft.autoAnswer ?? []).filter((_, i) => i !== idx);
      return { draft: { ...s.draft, autoAnswer: rules }, dirty: true };
    }),

  addRuleReply: (idx) =>
    set((s) => {
      const rules = (s.draft.autoAnswer ?? []).slice();
      if (idx < 0 || idx >= rules.length) return s;
      const reply = rules[idx].reply.concat({ name: "", value: 0 });
      rules[idx] = { ...rules[idx], reply };
      return { draft: { ...s.draft, autoAnswer: rules }, dirty: true };
    }),

  updateRuleReply: (ruleIdx, replyIdx, patch) =>
    set((s) => {
      const rules = (s.draft.autoAnswer ?? []).slice();
      if (ruleIdx < 0 || ruleIdx >= rules.length) return s;
      const reply = rules[ruleIdx].reply.slice();
      if (replyIdx < 0 || replyIdx >= reply.length) return s;
      reply[replyIdx] = { ...reply[replyIdx], ...patch };
      rules[ruleIdx] = { ...rules[ruleIdx], reply };
      return { draft: { ...s.draft, autoAnswer: rules }, dirty: true };
    }),

  removeRuleReply: (ruleIdx, replyIdx) =>
    set((s) => {
      const rules = (s.draft.autoAnswer ?? []).slice();
      if (ruleIdx < 0 || ruleIdx >= rules.length) return s;
      const reply = rules[ruleIdx].reply.filter((_, i) => i !== replyIdx);
      rules[ruleIdx] = { ...rules[ruleIdx], reply };
      return { draft: { ...s.draft, autoAnswer: rules }, dirty: true };
    }),

  setMode: (mode) => set({ mode }),
  setTargetSession: (sid) => set({ targetSession: sid }),

  scheduleSave: () => {
    if (!get().autoSave) return;
    if (saveTimer) clearTimeout(saveTimer);
    if (!get().saving) set({ saving: true });
    saveTimer = setTimeout(() => {
      saveTimer = null;
      // Autosave must never surface as an unhandled rejection (it would crash
      // the WebView to a white screen). On failure we keep `dirty` set and log,
      // so the next edit retries and the user can also save explicitly.
      void get()
        .save()
        .catch((e) => {
          console.error("[protocol] autosave failed:", e);
        });
    }, 700);
  },

  save: async () => {
    const { draft } = get();
    set({ saving: true });
    try {
      const saved = await protocol.save(toWireConfig(draft));
      await get().refreshList();
      // The backend returns the persisted config (with its assigned UUID), so
      // we can reliably point the editor at it without name-matching.
      const reloaded = await protocol.load(saved.id);
      set({
        selectedId: saved.id,
        draft: fromWireConfig(reloaded),
        dirty: false,
        saving: false,
        lastSavedAt: Date.now(),
      });
    } catch (e) {
      // Keep `dirty` so a later edit re-triggers autosave / explicit retry.
      set({ saving: false });
      throw e;
    }
  },

  remove: async (id) => {
    await protocol.delete(id);
    if (get().selectedId === id) {
      set({ selectedId: null, draft: emptyProtocol(), dirty: false });
    }
    await get().refreshList();
  },

  duplicateProtocol: async (id, newName) => {
    const cfg = await protocol.duplicate(id, newName);
    await get().refreshList();
    set({ selectedId: cfg.id, draft: fromWireConfig(cfg), dirty: false });
  },

  importProtocol: async (json) => {
    const parsed = JSON.parse(json) as Partial<ProtocolConfig>;
    if (!parsed || typeof parsed.name !== "string" || !Array.isArray(parsed.fields)) {
      throw new Error("bad-protocol-json");
    }
    // Strip the id (and timestamps) so the backend assigns a fresh UUID and the
    // import becomes a new project rather than overwriting the source.
    const cfg: ProtocolConfig = {
      ...(parsed as ProtocolConfig),
      id: "",
      createdAt: 0,
      updatedAt: 0,
    };
    const saved = await protocol.save(toWireConfig(cfg));
    await get().refreshList();
    set({ selectedId: saved.id, draft: fromWireConfig(saved), dirty: false });
    return saved;
  },

  previewSample: async (hex) => {
    const { draft } = get();
    const bytes = hexToBytes(hex);
    if (bytes.length === 0) {
      set({ sampleFrames: [] });
      return;
    }
    const frames = await protocol.parse(draft.id, bytesToBase64(bytes), toWireConfig(draft));
    set({ sampleFrames: frames });
  },

  encode: async (fields) => {
    const { draft } = get();
    return protocol.encode(draft.id, fields, toWireConfig(draft));
  },

  openLoopback: async () => {
    const { draft } = get();
    if (!draft.id) {
      // Must persist first so the loopback channel has a stable id.
      await get().save();
    }
    const id = get().draft.id;
    if (!id) return;
    await protocol.loopbackOpen(id, toWireConfig(get().draft));
    set({ loopbackId: id });

    // Subscribe to parsed frames BEFORE sending anything, so no frame
    // (including the auto sample below) is missed due to listener setup timing.
    if (!loopbackUnsub) {
      loopbackUnsub = await protocol.onFrame(id, (evt) => {
        useProtocolDesignerStore.setState((s) => ({
          loopbackFrames: appendFrame(
            s.loopbackFrames,
            {
              ...evt.frame,
              isReply: evt.isReply ?? false,
              dir: (evt.dir as ParsedFrame["dir"]) ?? (evt.isReply ? "reply" : "tx"),
            },
            s.accumulate,
          ),
        }));
      });
    }

    // Immediately push one sample frame so the channel isn't empty on open —
    // the user sees a parsed frame (and any auto-reply) right away instead of
    // a "no data" placeholder. Skip silently if the protocol can't encode yet.
    if (draft.fields.length > 0) {
      try {
        const sample: FieldValue[] = draft.fields.map((f) => ({
          name: f.name,
          value: sampleValue(f),
        }));
        const b64 = await get().encode(sample);
        await get().loopbackSend(b64);
      } catch {
        /* channel is open; just no demo frame */
      }
    }
  },

  closeLoopback: async () => {
    const id = get().loopbackId;
    if (id) await protocol.loopbackClose(id);
    if (loopbackUnsub) {
      await loopbackUnsub();
      loopbackUnsub = null;
    }
    set({ loopbackId: null, loopbackFrames: [] });
  },

  loopbackSend: async (rawBase64) => {
    const id = get().loopbackId;
    if (!id) return;
    await protocol.loopbackSend(id, rawBase64);
  },

  reloadLoopback: async () => {
    const id = get().loopbackId;
    if (!id) return;
    await protocol.loopbackReload(id, toWireConfig(get().draft));
  },

  pushLiveFrame: (frame) =>
    set((s) => ({
      liveFrames: appendFrame(
        s.liveFrames,
        { ...frame, dir: (frame.dir ?? "rx") as ParsedFrame["dir"] },
        s.accumulate,
      ),
    })),

  selectField: (name) => set({ selectedField: name }),

  toggleAccumulate: () => set((s) => ({ accumulate: !s.accumulate })),

  clearFrames: () => set({ loopbackFrames: [], liveFrames: [] }),

  setSendValue: (name, value) =>
    set((s) => {
      const id = s.draft.id || "__new__";
      const cur = s.sendValues[id] ?? {};
      return { sendValues: { ...s.sendValues, [id]: { ...cur, [name]: value } } };
    }),

  setSendBase: (name, base) =>
    set((s) => {
      const id = s.draft.id || "__new__";
      const cur = s.sendBases[id] ?? {};
      return { sendBases: { ...s.sendBases, [id]: { ...cur, [name]: base } } };
    }),

  seedSendExamples: (fields) =>
    set((s) => {
      const id = s.draft.id || "__new__";
      const cur = s.sendValues[id] ?? {};
      const seeded: Record<string, string> = { ...cur };
      for (const f of fields) {
        if (seeded[f.name] == null || seeded[f.name] === "") {
          seeded[f.name] = exampleSendValue(f);
        }
      }
      return { sendValues: { ...s.sendValues, [id]: seeded } };
    }),
}));

/** Prepend a parsed frame, honouring the `accumulate` flag. When accumulation
 *  is off, only the single latest frame is retained. */
function appendFrame(
  list: ParsedFrame[],
  frame: ParsedFrame,
  accumulate: boolean,
): ParsedFrame[] {
  if (!accumulate) return [frame];
  return [frame, ...list].slice(0, MAX_FRAMES);
}

/**
 * Auto-save: whenever the draft changes because of an edit (`dirty` flips on),
 * schedule a debounced persist. Loading / selecting / saving reset `dirty`, so
 * they don't re-trigger a save (which would otherwise loop on every reload).
 */
useProtocolDesignerStore.subscribe((state, prev) => {
  if (state.draft === prev.draft) return;
  if (state.dirty && state.autoSave) {
    state.scheduleSave();
  }
});
