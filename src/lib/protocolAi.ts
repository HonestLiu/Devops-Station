import type {
  AutoAnswerRule,
  ChecksumAlgo,
  Endian,
  FieldDataType,
  FieldDef,
  LengthField,
  ProtocolConfig,
} from "@/lib/types";

/**
 * Helpers for turning a natural-language description into a `ProtocolConfig`
 * via the LLM, then safely validating / normalising the model's JSON so it can
 * be dropped straight into the designer draft (`updateDraft`). The model is not
 * trusted: every field is whitelist-checked and repaired, so a half-broken
 * reply degrades to a usable protocol rather than crashing the editor.
 *
 * The AI output matches the *editor* shape of `ProtocolConfig` — in particular
 * `head` / `tail` are space-separated hex strings (e.g. `"AA BB"`), which is
 * exactly what `updateDraft` and the inputs expect.
 */

const CHECKSUM_ALGOS: ChecksumAlgo[] = [
  "none",
  "sum",
  "xor",
  "crc8",
  "crc16modbus",
  "crc32",
];

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

/** Extract a JSON object from the model's reply, tolerating markdown fences
 *  and surrounding prose. Returns the parsed value, or null when there's no
 *  usable `{ … }` block. */
export function parseAiJson(text: string): unknown | null {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Normalise a head/tail value to an upper-case, space-separated hex string.
 *  Accepts `"aabb"`, `"AA BB"`, `[0xAA, 0xBB]`, `[170, 187]`; returns null for
 *  anything that isn't valid hex. */
function normalizeHex(value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    const nums = value
      .map((v) => (typeof v === "number" ? v : parseInt(String(v), 10)))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 0xff);
    if (nums.length === 0) return null;
    return nums.map((n) => (n & 0xff).toString(16).padStart(2, "0").toUpperCase()).join(" ");
  }
  const txt = String(value).trim();
  if (!txt) return null;
  const cleaned = txt.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 0) return null;
  const padded = cleaned.length % 2 ? `0${cleaned}` : cleaned;
  const out: string[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    out.push(padded.slice(i, i + 2).toUpperCase());
  }
  return out.join(" ");
}

function isDataField(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null;
}

function sanitizeField(
  raw: Record<string, unknown>,
  fallbackName: string,
): FieldDef | null {
  const dataType = DATA_TYPES.includes(raw.dataType as FieldDataType)
    ? (raw.dataType as FieldDataType)
    : null;
  if (!dataType) return null; // cannot salvage a field without a valid type

  const rawName = typeof raw.name === "string" ? raw.name.trim() : "";
  const name = rawName || fallbackName;
  const displayName =
    typeof raw.displayName === "string" && raw.displayName.trim()
      ? raw.displayName.trim()
      : name;

  const lengthNum = Number(raw.length);
  const length =
    Number.isFinite(lengthNum) && lengthNum >= 1 ? Math.floor(lengthNum) : 1;

  const offsetNum = Number(raw.offset);
  const offset =
    Number.isFinite(offsetNum) && offsetNum >= 0 ? Math.floor(offsetNum) : 0;

  const scaleNum = Number(raw.scale);
  const scale = Number.isFinite(scaleNum) ? scaleNum : null;

  const unit =
    typeof raw.unit === "string" && raw.unit.trim() ? raw.unit.trim() : null;

  let enumMap: Record<string, string> | null = null;
  if (isDataField(raw.enumMap)) {
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.enumMap)) {
      if (typeof v === "string") m[String(k)] = v;
    }
    if (Object.keys(m).length > 0) enumMap = m;
  }

  const condition =
    typeof raw.condition === "string" && raw.condition.trim()
      ? raw.condition.trim()
      : null;

  return {
    name,
    displayName,
    offset,
    length,
    dataType,
    scale,
    unit,
    enumMap,
    condition,
  };
}

/** Re-assign field offsets sequentially starting after the frame head so the
 *  protocol is always contiguous and parseable, even if the model emitted
 *  overlapping / missing offsets. Keeps the model's relative order. */
function reassignOffsets(fields: FieldDef[]): FieldDef[] {
  // Offsets are *body-relative* (measured from the first byte after the frame
  // head). The encoder/parser add `headLen` themselves, so starting the cursor
  // at `headLen` here would double-count the head and push every field past
  // the frame end — which surfaced as "字段越界或校验失败" on every parse.
  let cursor = 0;
  return fields.map((f) => {
    const next = { ...f, offset: cursor };
    cursor += f.length;
    return next;
  });
}

function sanitizeChecksum(raw: unknown): ProtocolConfig["checksum"] {
  if (!isDataField(raw)) return null;
  const algo = CHECKSUM_ALGOS.includes(raw.algo as ChecksumAlgo)
    ? (raw.algo as ChecksumAlgo)
    : null;
  if (!algo || algo === "none") return null;
  // `null` / `undefined` / missing / `0` all mean "unbounded" (start of frame /
  // end of frame). `Number(null)` is `0`, so we must NOT treat a falsy value as
  // a real offset — otherwise the parser sees a zero-length checksum range and
  // reports a spurious "校验失败" on every frame.
  const toOffset = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.floor(n);
  };
  return {
    algo,
    start: toOffset(raw.start),
    end: toOffset(raw.end),
  };
}

function sanitizeLengthField(raw: unknown): LengthField | null {
  if (!isDataField(raw)) return null;
  const offsetNum = Number(raw.offset);
  const lengthNum = Number(raw.length);
  if (!Number.isFinite(offsetNum) || !Number.isFinite(lengthNum)) return null;
  return {
    offset: Math.max(0, Math.floor(offsetNum)),
    length: Math.max(1, Math.floor(lengthNum)),
    includeSelf: Boolean(raw.includeSelf),
  };
}

function sanitizeAutoAnswer(
  raw: unknown,
  fieldNames: Set<string>,
): AutoAnswerRule[] | null {
  if (!Array.isArray(raw)) return null;
  const rules: AutoAnswerRule[] = [];
  for (const item of raw) {
    if (!isDataField(item)) continue;
    const whenField = typeof item.whenField === "string" ? item.whenField : "";
    const whenValue = Number(item.whenValue);
    if (!whenField || !fieldNames.has(whenField) || !Number.isFinite(whenValue)) {
      continue;
    }
    const reply: { name: string; value: unknown }[] = [];
    if (Array.isArray(item.reply)) {
      for (const r of item.reply) {
        if (!isDataField(r)) continue;
        const name = typeof r.name === "string" ? r.name : "";
        if (fieldNames.has(name)) reply.push({ name, value: r.value });
      }
    }
    rules.push({
      enabled: item.enabled == null ? true : Boolean(item.enabled),
      note: typeof item.note === "string" ? item.note : null,
      whenField,
      whenValue,
      reply,
    });
  }
  return rules.length ? rules : null;
}

/**
 * Validate and repair a raw object from the model into a `ProtocolConfig`
 * (minus `id` / `createdAt` / `updatedAt`, which the store owns). Returns null
 * only when the name is missing — everything else is repaired to a sane default
 * so a partial reply is still usable.
 */
export function sanitizeProtocol(raw: unknown): ProtocolConfig | null {
  if (!isDataField(raw)) return null;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) return null;

  const endian: Endian =
    raw.endian === "little" || raw.endian === "big" ? raw.endian : "big";

  const head = normalizeHex(raw.head);
  const tail = normalizeHex(raw.tail);

  const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
  const goodFields: FieldDef[] = [];
  let idx = 0;
  for (const rf of rawFields) {
    if (!isDataField(rf)) continue;
    const f = sanitizeField(rf, `field${idx + 1}`);
    if (f) goodFields.push(f);
    idx++;
  }
  // Sort by the model's intended offset, then make them contiguous so the
  // protocol is parseable regardless of what the model emitted.
  goodFields.sort((a, b) => a.offset - b.offset);
  const fields = reassignOffsets(goodFields);

  const fieldNames = new Set(fields.map((f) => f.name));

  const timeoutNum = Number(raw.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutNum) && timeoutNum >= 0 ? Math.floor(timeoutNum) : 50;

  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : null;

  // Build the documentation deterministically from the validated config so its
  // frame offsets, lengths and command/value tables always match what the
  // parser (and the exported C) actually decode. The AI-supplied `doc` is
  // ignored for the factual content to prevent drift.
  const doc = buildProtocolDoc({
    id: "",
    name,
    description,
    doc: null,
    head,
    tail,
    lengthField: sanitizeLengthField(raw.lengthField),
    fields,
    checksum: sanitizeChecksum(raw.checksum),
    endian,
    timeoutMs,
    autoAnswer: sanitizeAutoAnswer(raw.autoAnswer, fieldNames),
    createdAt: 0,
    updatedAt: 0,
  });

  return {
    id: "",
    name,
    description,
    doc,
    head,
    tail,
    lengthField: sanitizeLengthField(raw.lengthField),
    fields,
    checksum: sanitizeChecksum(raw.checksum),
    endian,
    timeoutMs,
    autoAnswer: sanitizeAutoAnswer(raw.autoAnswer, fieldNames),
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * A compact, valid example protocol (as a JSON-looking string) embedded in the
 * system prompt so the model can mirror the exact expected shape. Kept minimal
 * to save tokens.
 */
export function demoProtocolHint(): string {
  return JSON.stringify(
    {
      name: "传感器查询帧",
      description: "示例：帧头 AA BB，命令字 + 温度(×0.1) + 湿度 + 序列号，CRC16 校验",
      doc: "",
      head: "AA BB",
      tail: "0D 0A",
      endian: "big",
      timeoutMs: 50,
      checksum: { algo: "crc16modbus", start: null, end: null },
      lengthField: null,
      fields: [
        {
          name: "addr",
          displayName: "设备地址",
          offset: 2,
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
          offset: 3,
          length: 1,
          dataType: "uint8",
          scale: null,
          unit: null,
          enumMap: null,
          condition: null,
        },
        {
          name: "temperature",
          displayName: "温度",
          offset: 4,
          length: 2,
          dataType: "int16",
          scale: 0.1,
          unit: "°C",
          enumMap: null,
          condition: null,
        },
      ],
      autoAnswer: [
        {
          enabled: true,
          note: "收到写入命令时回送确认",
          whenField: "cmd",
          whenValue: 2,
          reply: [
            { name: "addr", value: 0 },
            { name: "cmd", value: 1 },
            { name: "temperature", value: 0 },
          ],
        },
      ],
    },
    null,
    2,
  );
}

/** Build the system prompt for the protocol-generation request. */
export function protocolSystemPrompt(): string {
  return `你是一个串口/嵌入式设备的通信协议设计助手。用户的描述可能非常简短（例如"我需要一个智能风扇的协议"），你必须据此**自行推断**出一份完整、合理、可直接使用的协议配置，绝不能反问用户，也不能输出任何解释性文字。

# 输出格式（最重要）
- 只输出**一个** JSON 对象，禁止任何前导/后置说明、禁止 markdown 代码块标记（不要出现 \`\`\`）。
- 直接以 { 开头、以 } 结尾。多一个字都不行。

# 字段定义（键名大小写敏感，禁止自创字段）
- name: 协议名称（字符串，必填，简短，如"智能风扇控制协议"）
- description: 一句话说明（字符串，可为 ""）
- doc: 文档由系统在生成后**根据字段自动生成并保证与解析帧一致**，你无需（也不要）自行编写 doc；保持此字段为空字符串 "" 即可。你要做的是把 name / head / tail / fields（含 enumMap 真实取值）/ checksum / autoAnswer 写准确——文档会基于这些自动生成。
- head: 帧头，空格分隔的大写十六进制，如 "AA BB"；无则 null
- tail: 帧尾，同 head 格式；无则 null
- endian: 只能是 "big" 或 "little"（默认 "big"）
- timeoutMs: 数字，默认 50
- checksum: { "algo": "...", "start": null, "end": null }，algo 只能取：
  "none" | "sum" | "xor" | "crc8" | "crc16modbus" | "crc32"
  不确定时用 "crc16modbus"；不要校验则写 { "algo": "none" }
- lengthField: { "offset": 数字, "length": 数字, "includeSelf": 布尔 } 或 null（一般 null）
- fields: 数组，每项为：
  { "name", "displayName", "offset", "length", "dataType", "scale", "unit", "enumMap", "condition" }
  - dataType 只能取："uint8" | "int16" | "uint16" | "int32" | "uint32" | "float32" | "float64" | "hexstring" | "asciistring" | "bitfield"
  - 所有字段都必填齐全，不能省略任何键；用不到的值写 null
  - offset 从帧头之后按 length 连续累加（不要留空、不要重叠、不要从 0 开始除非没有帧头）；length ≥ 1 且为整数
  - scale 为数字或 null（如 0.1 表示 原始值×0.1）；unit 为字符串或 null（如 "°C"、"%"）；enumMap 为 { "原始值": "含义" } 或 null；condition 为字符串或 null
  - displayName 用中文或贴切的简短名
- autoAnswer: 数组或 null；每条规则 { "enabled": true, "note": 字符串或 null, "whenField": 字段名, "whenValue": 数字, "reply": [{ "name": 字段名, "value": 数字 }] }
  whenField / reply[].name 必须引用 fields 里真实存在的 name；没有自动应答需求则写 null

# 当描述很简单时（必读）
用户只说"XX设备的协议"时，按下面规则**自动补全**，不要追问：
1. 帧头默认用 "AA BB"（除非用户指定）；帧尾默认 "0D 0A"；校验默认 "crc16modbus"。
2. 至少包含一个命令/功能字段（如 cmd，uint8），并用 enumMap 列出该设备常见的几个命令（开/关/调速/查询…）。
3. 根据设备类型，挑选 2~5 个最典型的遥测或控制字段，例如：
   - 风扇/电机类：cmd(开关/档位)、speed(转速档位, uint8)、rpm(转速, uint16)、temp(温度, int16, scale 0.1, unit °C)、status(uint8, enumMap)
   - 传感器类：addr、cmd、温度/湿度/气压/光照(带合适 dataType 与 unit)、序列号(hexstring)
   - 灯具类：cmd(开/关/调光)、brightness(亮度 0~100, uint8, unit %)、color(颜色, uint8 或 hexstring)、temp
   - 电源/电池类：cmd、voltage(电压, uint16, scale 0.01, unit V)、current(电流, uint16, scale 0.01, unit A)、percent(电量, uint8, unit %)
   - 通用：加一个 deviceId/addr(uint8) 与 status(uint8, enumMap) 基本不会错。
4. 字段数量控制在 3~8 个，别过度设计。
5. 可顺带给一条最合理的自动应答（如收到"查询"命令回送当前状态），做不到就写 null。
6. 必须同步生成 **doc**：用上面生成的字段、enumMap、checksum、自动应答，写出带帧结构表格、命令字/取值列表、通信示例、注意事项与 CRC 代码的完整 Markdown 文档（参考示例里的 doc 字段）。doc 不是可选，简短提示也要产出完整手册。

# 禁止事项
- 禁止输出 JSON 以外的任何文字、注释、思考过程。
- 禁止自创 dataType、自创字段名、使用小写十六进制、或让 offset 出现重叠/空缺。
- 禁止把校验算法写成 crc16/ccitt 等未列出的名字。
- 禁止把 doc 写成一句简介或占位符；doc 必须包含帧结构表、命令/取值表、示例与注意事项，且与生成的字段一致。

# 示例（严格照此结构，不要抄内容）
${demoProtocolHint()}`;
}

// ---------------------------------------------------------------------------
// Deterministic documentation
// ---------------------------------------------------------------------------
//
// The AI-authored `doc` is prose and has historically drifted from the actual
// frame layout / enum values, making it contradict the parser (and the
// generated C). To guarantee the doc and the parse frame stay in sync, we
// build the factual parts of the documentation directly from the validated
// `ProtocolConfig`: offsets, lengths, command/value tables and the example
// frame are all derived from the same numbers the decoder uses.

function hexToBytes(h: string | null | undefined): number[] {
  if (!h) return [];
  const cleaned = h.replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (!cleaned) return [];
  const padded = cleaned.length % 2 ? `0${cleaned}` : cleaned;
  const out: number[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    out.push(parseInt(padded.slice(i, i + 2), 16) & 0xff);
  }
  return out;
}

function checksumLen(algo: string | undefined): number {
  if (algo === "crc32") return 4;
  if (algo === "crc16modbus") return 2;
  if (algo === "crc8" || algo === "sum" || algo === "xor") return 1;
  return 0;
}

/** Append `value` (big or little endian) into `buf` at `off`, multi-byte. */
function writeInt(buf: number[], off: number, value: number, length: number, endian: string) {
  for (let i = 0; i < length; i++) {
    const b = (value >> (8 * i)) & 0xff;
    buf[off + (endian === "little" ? i : length - 1 - i)] = b;
  }
}

function computeChecksum(buf: number[], algo: string | undefined): number[] {
  const len = checksumLen(algo);
  if (len === 0) return [];
  let out: number[] = [];
  if (algo === "sum") {
    let s = 0;
    for (const b of buf) s = (s + b) & 0xff;
    out = [s];
  } else if (algo === "xor") {
    let x = 0;
    for (const b of buf) x ^= b;
    out = [x];
  } else if (algo === "crc8") {
    let crc = 0x00;
    for (const b of buf) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    out = [crc];
  } else if (algo === "crc16modbus") {
    let crc = 0xffff;
    for (const b of buf) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = (crc & 0x0001) ? ((crc >> 1) ^ 0xa001) & 0xffff : (crc >> 1) & 0xffff;
    }
    out = [(crc >> 8) & 0xff, crc & 0xff]; // big-endian byte order
  } else if (algo === "crc32") {
    let crc = 0xffffffff;
    for (const b of buf) {
      crc ^= b;
      for (let k = 0; k < 8; k++) crc = (crc & 0x00000001) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    crc = ~crc >>> 0;
    out = [(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff];
  }
  return out.slice(0, len);
}

/** Format an enum key as hex when it parses as an integer, else as-is. */
function fmtEnumKey(k: string): string {
  const n = Number(k);
  if (Number.isInteger(n) && /^-?\d+$/.test(k.trim())) return `0x${n.toString(16).toUpperCase()}`;
  return k;
}

/** Pick a stable sample value for a field (prefers first enum value). */
function sampleValue(f: FieldDef): number {
  if (f.enumMap && Object.keys(f.enumMap).length) {
    const first = Object.keys(f.enumMap)[0];
    const n = Number(first);
    if (Number.isFinite(n)) return n;
  }
  switch (f.dataType) {
    case "int16":
    case "int32":
      return 0;
    case "float32":
      return 1.5;
    case "float64":
      return 2.25;
    default:
      return 1;
  }
}

/**
 * Build a complete, accurate Markdown document from a validated config. Every
 * number here matches what `generateCProtocol` / the live parser emit, so the
 * doc can never contradict the actual frame.
 */
export function buildProtocolDoc(cfg: ProtocolConfig): string {
  const name = cfg.name || "协议";
  const endian = cfg.endian ?? "big";
  const algo = cfg.checksum?.algo ?? "none";
  const csLen = checksumLen(algo);

  const head = hexToBytes(cfg.head as unknown as string);
  const tail = hexToBytes(cfg.tail as unknown as string);
  const headLen = head.length;
  const tailLen = tail.length;

  const fields = cfg.fields
    .slice()
    .sort((a, b) => a.offset - b.offset);

  let maxEnd = 0;
  for (const f of fields) maxEnd = Math.max(maxEnd, f.offset + f.length);

  // Absolute offsets in the wire frame: head, then body(fields), checksum, tail.
  const bodyStart = headLen;
  const csStart = bodyStart + maxEnd;
  const tailStart = csStart + csLen;
  const total = tailStart + tailLen;

  const lines: string[] = [];
  lines.push(`# ${name}`);
  lines.push("");
  if (cfg.description) {
    lines.push(cfg.description);
    lines.push("");
  }
  lines.push(
    `本协议由 DevOps Station 协议设计器自动生成，文档中的帧结构、偏移与取值均与解析器（及导出的 C 代码）严格一致。`,
  );
  lines.push("");

  // --- Frame structure table ---
  lines.push(`## 帧结构`);
  lines.push("");
  lines.push(`总帧长 **${total}** 字节（固定长度，便于解析）。`);
  lines.push("");
  lines.push(`| 字段 | 偏移 | 长度 | 数据类型 | 说明 |`);
  lines.push(`| :--- | :--- | :--- | :--- | :--- |`);
  if (headLen > 0) {
    lines.push(`| 帧头 | 0 | ${headLen} | - | 固定 \`${cfg.head}\` |`);
  }
  fields.forEach((f) => {
    const off = bodyStart + f.offset;
    const notes: string[] = [];
    if (f.scale) notes.push(`×${f.scale}`);
    if (f.unit) notes.push(f.unit);
    if (f.enumMap && Object.keys(f.enumMap).length) notes.push(`枚举见下表`);
    lines.push(
      `| ${f.displayName || f.name} (\`${f.name}\`) | ${off} | ${f.length} | ${f.dataType} | ${notes.join("，") || "—"} |`,
    );
  });
  if (csLen > 0) {
    lines.push(`| 校验 | ${csStart} | ${csLen} | - | ${algo} 校验码 |`);
  }
  if (tailLen > 0) {
    lines.push(`| 帧尾 | ${tailStart} | ${tailLen} | - | 固定 \`${cfg.tail}\` |`);
  }
  lines.push("");

  // --- Enum / command value tables (synced with field enumMaps) ---
  const enumFields = fields.filter(
    (f) => f.enumMap && Object.keys(f.enumMap).length > 0,
  );
  if (enumFields.length > 0) {
    lines.push(`## 取值说明`);
    lines.push("");
    for (const f of enumFields) {
      lines.push(`### ${f.displayName || f.name}（\`${f.name}\`）`);
      lines.push("");
      lines.push(`| 值 | 含义 |`);
      lines.push(`| :--- | :--- |`);
      for (const [k, v] of Object.entries(f.enumMap!)) {
        lines.push(`| ${fmtEnumKey(k)} | ${v} |`);
      }
      lines.push("");
    }
  }

  // --- Example frame (computed from the real layout) ---
  const buf = new Array<number>(total).fill(0);
  for (let i = 0; i < headLen; i++) buf[i] = head[i];
  for (const f of fields) {
    const off = bodyStart + f.offset;
    if (f.dataType === "hexstring" || f.dataType === "asciistring") {
      // leave as zeros (placeholder)
    } else if (f.dataType === "float32") {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, sampleValue(f), endian !== "little");
      for (let i = 0; i < 4; i++) buf[off + i] = dv.getUint8(i);
    } else if (f.dataType === "float64") {
      const dv = new DataView(new ArrayBuffer(8));
      dv.setFloat64(0, sampleValue(f), endian !== "little");
      for (let i = 0; i < 8; i++) buf[off + i] = dv.getUint8(i);
    } else {
      writeInt(buf, off, sampleValue(f), f.length, endian);
    }
  }
  // The Rust encoder/parser checksum the full range *including the tail*
  // (head + body + tail). Compute the same range here so the doc's example
  // frame matches what `encode`/`parse` actually produce — otherwise pasting
  // the documented frame back into the parser yields a "校验失败".
  const crc = computeChecksum(buf.slice(0, tailStart), algo);
  for (let i = 0; i < csLen; i++) buf[csStart + i] = crc[i] ?? 0;
  for (let i = 0; i < tailLen; i++) buf[tailStart + i] = tail[i];

  const hexStr = buf.map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
  lines.push(`## 通信示例`);
  lines.push("");
  lines.push(`以下为一帧示例（各字段取示例值，校验按 ${algo} 实时计算），十六进制：`);
  lines.push("");
  lines.push("```");
  lines.push(hexStr);
  lines.push("```");
  lines.push("");

  // --- Notes / auto-answer / checksum params ---
  lines.push(`## 自动应答与注意事项`);
  lines.push("");
  lines.push(`- **字节序**：${endian === "little" ? "小端（Little-Endian）" : "大端（Big-Endian）"}，多字节字段高字节${endian === "little" ? "在后" : "在前"}。`);
  if (algo !== "none") {
    lines.push(`- **校验算法**：${algo}。`);
    if (algo === "crc16modbus") {
      lines.push(`  初始值 0xFFFF，多项式 0x8005，计算范围为帧头起始至校验字段前（偏移 0 到 ${csStart}，共 ${csStart} 字节），结果为大端序填入校验字段。`);
    } else if (algo === "crc32") {
      lines.push(`  初始值 0xFFFFFFFF，多项式 0xEDB88320，计算范围为整个校验前字段，结果大端序填入。`);
    } else {
      lines.push(`  计算范围为帧头起始至校验字段前（共 ${csStart} 字节）。`);
    }
  } else {
    lines.push(`- 未配置校验。`);
  }
  if (headLen > 0) lines.push(`- **帧头**：固定 \`${cfg.head}\`。`);
  if (tailLen > 0) lines.push(`- **帧尾**：固定 \`${cfg.tail}\`。`);
  lines.push(`- **帧同步**：以帧尾作为结束标识，并结合帧头与固定长度 ${total} 字节综合校验。`);
  lines.push(`- **超时**：默认 ${cfg.timeoutMs} ms。`);

  if (cfg.autoAnswer && cfg.autoAnswer.length > 0) {
    lines.push("");
    lines.push(`### 自动应答规则`);
    lines.push("");
    for (const r of cfg.autoAnswer) {
      const note = r.note ? `（${r.note}）` : "";
      lines.push(`- 当 \`${r.whenField} == ${fmtEnumKey(String(r.whenValue))}\` 时自动回复${note}。`);
    }
  }

  if (algo === "crc16modbus") {
    lines.push("");
    lines.push(`## CRC16-MODBUS 计算示例（C 语言）`);
    lines.push("");
    lines.push("```c");
    lines.push(`#include <stdint.h>`);
    lines.push("");
    lines.push(`uint16_t crc16_modbus(uint8_t *data, uint16_t len) {`);
    lines.push(`    uint16_t crc = 0xFFFF;`);
    lines.push(`    for (uint16_t i = 0; i < len; i++) {`);
    lines.push(`        crc ^= data[i];`);
    lines.push(`        for (int j = 0; j < 8; j++)`);
    lines.push(`            crc = (crc & 0x0001) ? (uint16_t)((crc >> 1) ^ 0xA001) : (uint16_t)(crc >> 1);`);
    lines.push(`    }`);
    lines.push(`    return crc; // 大端序：高字节在前`);
    lines.push(`}`);
    lines.push("```");
  }

  return lines.join("\n");
}
