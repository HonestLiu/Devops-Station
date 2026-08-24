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
function reassignOffsets(fields: FieldDef[], headLen: number): FieldDef[] {
  let cursor = headLen;
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
  const startNum = Number(raw.start);
  const endNum = Number(raw.end);
  return {
    algo,
    start: Number.isFinite(startNum) && startNum >= 0 ? Math.floor(startNum) : null,
    end: Number.isFinite(endNum) && endNum >= 0 ? Math.floor(endNum) : null,
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
  const headLen = head ? head.split(" ").length : 0;

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
  const fields = reassignOffsets(goodFields, headLen);

  const fieldNames = new Set(fields.map((f) => f.name));

  const timeoutNum = Number(raw.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutNum) && timeoutNum >= 0 ? Math.floor(timeoutNum) : 50;

  const description =
    typeof raw.description === "string" && raw.description.trim()
      ? raw.description.trim()
      : null;

  return {
    id: "",
    name,
    description,
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

# 禁止事项
- 禁止输出 JSON 以外的任何文字、注释、思考过程。
- 禁止自创 dataType、自创字段名、使用小写十六进制、或让 offset 出现重叠/空缺。
- 禁止把校验算法写成 crc16/ccitt 等未列出的名字。

# 示例（严格照此结构，不要抄内容）
${demoProtocolHint()}`;
}
