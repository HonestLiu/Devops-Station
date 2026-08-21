/**
 * HMI dashboard widget registry ("上位机" 控件库).
 *
 * Every widget type declares:
 *  - its fixed display-variable slots (vars) — the ONLY fields a parse
 *    function may return;
 *  - a suggested raw-payload template and a default parse function body that
 *    decodes it — works out of the box, user can edit/extend later;
 *  - an optional default publish function body (interactive widgets).
 *
 * Parse/publish function bodies are plain JS *bodies* (no `function` wrapper):
 * `new Function("payload", "topic", body)` executes them. They must `return`
 * an object whose keys are exactly the declared vars.
 */

export interface WidgetVar {
  key: string;
  type: "number" | "string" | "boolean" | "any";
  label: string;
  desc: string;
}

export interface WidgetConfigField {
  key: string;
  label: string;
  type: "number" | "string" | "boolean" | "color" | "textarea";
  def: unknown;
  options?: string[];
}

export interface WidgetMeta {
  type: string;
  cat: CategoryKey;
  labelKey: string;
  /** Default grid size in cols × rows. */
  w: number;
  h: number;
  vars: WidgetVar[];
  /** Suggested raw payload (JSON) the default parse fn understands. */
  template: string;
  /** Default parse function body: (payload, topic) => vars object. */
  parse: string;
  /** Default publish function body: (value) => payload string. */
  publish?: string;
  /** Human hint of what `value` is for interactive widgets. */
  publishSample?: string;
  config?: WidgetConfigField[];
}

export type CategoryKey =
  | "base"
  | "color"
  | "data"
  | "env"
  | "media"
  | "security"
  | "scene"
  | "info"
  | "composite"
  | "chart"
  | "alarm";

export const CATEGORY_KEYS: CategoryKey[] = [
  "base",
  "color",
  "data",
  "env",
  "media",
  "security",
  "scene",
  "info",
  "composite",
  "chart",
  "alarm",
];

// Shared default parse/publish bodies ----------------------------------------

/** Parse a JSON payload and expose its `value` field (or the whole payload). */
const P_JSON_VALUE = `const data = JSON.parse(payload);
return { value: data.value ?? data };`;

/** Parse a JSON payload's `state`/`power` boolean. */
const P_BOOL = `const data = JSON.parse(payload);
return { value: data.value ?? data.state ?? data.power ?? (payload === "1" || payload === "ON" || payload === "true") };`;

/** Publish a JSON object with a single field `value`. */
const PB_JSON_VALUE = `return JSON.stringify({ value });`;

/** Publish the raw value as-is (string/number → string). */
const PB_RAW = `return String(value);`;

// Registry -------------------------------------------------------------------

export const WIDGETS: Record<string, WidgetMeta> = {
  // ---- 基础操作 --------------------------------------------------------------
  button: {
    type: "button",
    cat: "base",
    labelKey: "dash.w.button",
    w: 2,
    h: 1,
    vars: [{ key: "pressed", type: "boolean", label: "pressed", desc: "按钮按下状态（点动模式下短暂为 true）" }],
    template: `{ "state": "pressed" }`,
    parse: P_BOOL,
    publish: `return payload; // 原样发送按下时的 payload（可在配置中自定义）`,
    publishSample: `"ON"`,
    config: [
      { key: "mode", label: "模式", type: "string", def: "momentary", options: ["momentary", "latching"] },
      { key: "onPayload", label: "按下/打开载荷", type: "string", def: "ON" },
      { key: "offPayload", label: "释放/关闭载荷", type: "string", def: "OFF" },
    ],
  },
  toggle: {
    type: "toggle",
    cat: "base",
    labelKey: "dash.w.toggle",
    w: 2,
    h: 1,
    vars: [{ key: "value", type: "boolean", label: "value", desc: "开关状态（true=开）" }],
    template: `{ "state": true }`,
    parse: P_BOOL,
    publish: `return value ? "ON" : "OFF";`,
    publishSample: "true（开）→ \"ON\"",
  },
  slider: {
    type: "slider",
    cat: "base",
    labelKey: "dash.w.slider",
    w: 4,
    h: 1,
    vars: [{ key: "value", type: "number", label: "value", desc: "滑轨当前值" }],
    template: `{ "level": 60 }`,
    parse: `const data = JSON.parse(payload);
return { value: Number(data.level ?? data.value ?? 0) };`,
    publish: `return String(value);`,
    publishSample: "60 → \"60\"",
    config: [
      { key: "min", label: "最小值", type: "number", def: 0 },
      { key: "max", label: "最大值", type: "number", def: 100 },
    ],
  },
  knob: {
    type: "knob",
    cat: "base",
    labelKey: "dash.w.knob",
    w: 2,
    h: 2,
    vars: [{ key: "value", type: "number", label: "value", desc: "旋钮角度对应的值" }],
    template: `{ "temp": 26.5 }`,
    parse: `const data = JSON.parse(payload);
return { value: Number(data.value ?? data.temp ?? 0) };`,
    publish: `return JSON.stringify({ value });`,
    publishSample: "26.5 → {\"value\":26.5}",
    config: [
      { key: "min", label: "最小值", type: "number", def: 0 },
      { key: "max", label: "最大值", type: "number", def: 100 },
      { key: "unit", label: "单位", type: "string", def: "" },
    ],
  },

  // ---- 颜色 / 光效 ------------------------------------------------------------
  colorPicker: {
    type: "colorPicker",
    cat: "color",
    labelKey: "dash.w.colorPicker",
    w: 2,
    h: 2,
    vars: [{ key: "color", type: "string", label: "color", desc: "十六进制颜色，如 #FF8800" }],
    template: `{ "color": "#FF8800" }`,
    parse: `const data = JSON.parse(payload);
return { color: data.color ?? data.hue ?? "#FFFFFF" };`,
    publish: `return String(value);`,
    publishSample: "#FF8800",
  },
  colorTemp: {
    type: "colorTemp",
    cat: "color",
    labelKey: "dash.w.colorTemp",
    w: 4,
    h: 1,
    vars: [{ key: "temp", type: "number", label: "temp", desc: "色温（K，如 2700~6500）" }],
    template: `{ "ct": 4000 }`,
    parse: `const data = JSON.parse(payload);
return { temp: Number(data.ct ?? data.temp ?? 4000) };`,
    publish: `return String(value);`,
    publishSample: "4000",
    config: [
      { key: "min", label: "最小色温", type: "number", def: 2700 },
      { key: "max", label: "最大色温", type: "number", def: 6500 },
    ],
  },
  rgbInput: {
    type: "rgbInput",
    cat: "color",
    labelKey: "dash.w.rgbInput",
    w: 3,
    h: 2,
    vars: [
      { key: "r", type: "number", label: "r", desc: "红 0-255" },
      { key: "g", type: "number", label: "g", desc: "绿 0-255" },
      { key: "b", type: "number", label: "b", desc: "蓝 0-255" },
    ],
    template: `{ "rgb": [255, 136, 0] }`,
    parse: `const data = JSON.parse(payload);
const [r, g, b] = Array.isArray(data.rgb) ? data.rgb : [255, 255, 255];
return { r: Number(r), g: Number(g), b: Number(b) };`,
    publish: `return JSON.stringify({ rgb: [value.r, value.g, value.b] });`,
    publishSample: "{r:255,g:136,b:0}",
  },

  // ---- 数据显示 --------------------------------------------------------------
  gauge: {
    type: "gauge",
    cat: "data",
    labelKey: "dash.w.gauge",
    w: 3,
    h: 3,
    vars: [
      { key: "value", type: "number", label: "value", desc: "仪表当前值" },
      { key: "unit", type: "string", label: "unit", desc: "单位（可选）" },
    ],
    template: `{ "value": 72.5, "unit": "℃" }`,
    parse: `const data = JSON.parse(payload);
return { value: Number(data.value ?? data.v ?? 0), unit: data.unit ?? data.u ?? "" };`,
    config: [
      { key: "min", label: "量程下限", type: "number", def: 0 },
      { key: "max", label: "量程上限", type: "number", def: 100 },
    ],
  },
  numberText: {
    type: "numberText",
    cat: "data",
    labelKey: "dash.w.numberText",
    w: 2,
    h: 1,
    vars: [
      { key: "text", type: "string", label: "text", desc: "显示文本" },
      { key: "unit", type: "string", label: "unit", desc: "单位（可选）" },
    ],
    template: `{ "value": 24.6 }`,
    parse: `const data = JSON.parse(payload);
return { text: String(data.value ?? data.v ?? ""), unit: data.unit ?? "" };`,
  },
  progress: {
    type: "progress",
    cat: "data",
    labelKey: "dash.w.progress",
    w: 4,
    h: 1,
    vars: [
      { key: "value", type: "number", label: "value", desc: "进度 0-100" },
      { key: "label", type: "string", label: "label", desc: "进度条文字（可选）" },
    ],
    template: `{ "progress": 63 }`,
    parse: `const data = JSON.parse(payload);
return { value: Number(data.progress ?? data.value ?? 0), label: data.label ?? "" };`,
  },
  battery: {
    type: "battery",
    cat: "data",
    labelKey: "dash.w.battery",
    w: 2,
    h: 1,
    vars: [
      { key: "level", type: "number", label: "level", desc: "电量 0-100" },
      { key: "charging", type: "boolean", label: "charging", desc: "是否充电中" },
    ],
    template: `{ "battery": 87, "charging": true }`,
    parse: `const data = JSON.parse(payload);
return { level: Number(data.battery ?? data.level ?? 0), charging: !!data.charging };`,
  },

  // ---- 环境监测 --------------------------------------------------------------
  tempCard: {
    type: "tempCard",
    cat: "env",
    labelKey: "dash.w.tempCard",
    w: 3,
    h: 2,
    vars: [
      { key: "temp", type: "number", label: "temp", desc: "温度" },
      { key: "unit", type: "string", label: "unit", desc: "单位（℃/℉）" },
    ],
    template: `{ "temperature": 26.3, "unit": "℃" }`,
    parse: `const data = JSON.parse(payload);
return { temp: Number(data.temperature ?? data.temp ?? 0), unit: data.unit ?? "℃" };`,
  },
  humidityCard: {
    type: "humidityCard",
    cat: "env",
    labelKey: "dash.w.humidityCard",
    w: 3,
    h: 2,
    vars: [
      { key: "humidity", type: "number", label: "humidity", desc: "湿度 %" },
      { key: "unit", type: "string", label: "unit", desc: "单位（%）" },
    ],
    template: `{ "humidity": 58.4 }`,
    parse: `const data = JSON.parse(payload);
return { humidity: Number(data.humidity ?? data.humi ?? 0), unit: "%" };`,
  },
  pm25Card: {
    type: "pm25Card",
    cat: "env",
    labelKey: "dash.w.pm25Card",
    w: 3,
    h: 2,
    vars: [
      { key: "pm25", type: "number", label: "pm25", desc: "PM2.5 浓度 μg/m³" },
      { key: "level", type: "string", label: "level", desc: "空气质量等级（优/良/…）" },
    ],
    template: `{ "pm25": 35, "level": "良" }`,
    parse: `const data = JSON.parse(payload);
return { pm25: Number(data.pm25 ?? data.pm2_5 ?? 0), level: data.level ?? "" };`,
  },
  envCard: {
    type: "envCard",
    cat: "env",
    labelKey: "dash.w.envCard",
    w: 4,
    h: 2,
    vars: [
      { key: "temp", type: "number", label: "temp", desc: "温度" },
      { key: "humidity", type: "number", label: "humidity", desc: "湿度 %" },
      { key: "pm25", type: "number", label: "pm25", desc: "PM2.5" },
      { key: "unit", type: "string", label: "unit", desc: "温度单位" },
    ],
    template: `{ "temperature": 26.3, "humidity": 58.4, "pm25": 35, "unit": "℃" }`,
    parse: `const data = JSON.parse(payload);
return { temp: Number(data.temperature ?? data.temp ?? 0), humidity: Number(data.humidity ?? 0), pm25: Number(data.pm25 ?? 0), unit: data.unit ?? "℃" };`,
  },

  // ---- 媒体控制 --------------------------------------------------------------
  mediaControls: {
    type: "mediaControls",
    cat: "media",
    labelKey: "dash.w.mediaControls",
    w: 4,
    h: 1,
    vars: [{ key: "playing", type: "boolean", label: "playing", desc: "是否播放中" }],
    template: `{ "state": "playing" }`,
    parse: P_BOOL,
    publish: `return String(value); // "prev" | "play" | "pause" | "toggle" | "next"`,
    publishSample: "\"toggle\"",
  },
  volumeSlider: {
    type: "volumeSlider",
    cat: "media",
    labelKey: "dash.w.volumeSlider",
    w: 4,
    h: 1,
    vars: [{ key: "volume", type: "number", label: "volume", desc: "音量 0-100" }],
    template: `{ "volume": 42 }`,
    parse: `const data = JSON.parse(payload);
return { volume: Number(data.volume ?? data.value ?? 0) };`,
    publish: `return String(value);`,
    publishSample: "42 → \"42\"",
  },
  songInfo: {
    type: "songInfo",
    cat: "media",
    labelKey: "dash.w.songInfo",
    w: 4,
    h: 2,
    vars: [
      { key: "title", type: "string", label: "title", desc: "歌曲名" },
      { key: "artist", type: "string", label: "artist", desc: "歌手" },
      { key: "album", type: "string", label: "album", desc: "专辑（可选）" },
    ],
    template: `{ "title": "晴天", "artist": "周杰伦", "album": "叶惠美" }`,
    parse: `const data = JSON.parse(payload);
return { title: data.title ?? "", artist: data.artist ?? "", album: data.album ?? "" };`,
  },

  // ---- 安防 / 门窗 ------------------------------------------------------------
  lockCard: {
    type: "lockCard",
    cat: "security",
    labelKey: "dash.w.lockCard",
    w: 2,
    h: 2,
    vars: [{ key: "locked", type: "boolean", label: "locked", desc: "是否已锁定" }],
    template: `{ "locked": true }`,
    parse: `const data = JSON.parse(payload);
return { locked: data.locked ?? data.lock ?? payload === "LOCKED" };`,
    publish: `return value ? "LOCK" : "UNLOCK";`,
    publishSample: "true → \"LOCK\"",
  },
  doorSensor: {
    type: "doorSensor",
    cat: "security",
    labelKey: "dash.w.doorSensor",
    w: 2,
    h: 2,
    vars: [{ key: "open", type: "boolean", label: "open", desc: "门窗是否打开" }],
    template: `{ "contact": "open" }`,
    parse: `const data = JSON.parse(payload);
return { open: data.contact === "open" || data.open === true || data.state === "open" };`,
  },
  motionSensor: {
    type: "motionSensor",
    cat: "security",
    labelKey: "dash.w.motionSensor",
    w: 2,
    h: 2,
    vars: [{ key: "motion", type: "boolean", label: "motion", desc: "是否检测到人体" }],
    template: `{ "motion": true }`,
    parse: `const data = JSON.parse(payload);
return { motion: data.motion ?? data.detected ?? payload === "1" };`,
  },
  cameraCard: {
    type: "cameraCard",
    cat: "security",
    labelKey: "dash.w.cameraCard",
    w: 4,
    h: 3,
    vars: [
      { key: "online", type: "boolean", label: "online", desc: "摄像头在线状态" },
      { key: "snapshot", type: "string", label: "snapshot", desc: "截图 URL（可选）" },
    ],
    template: `{ "online": true, "snapshot": "" }`,
    parse: `const data = JSON.parse(payload);
return { online: data.online ?? true, snapshot: data.snapshot ?? "" };`,
  },

  // ---- 场景 / 自动化 ----------------------------------------------------------
  sceneButton: {
    type: "sceneButton",
    cat: "scene",
    labelKey: "dash.w.sceneButton",
    w: 3,
    h: 1,
    vars: [],
    template: `{}`,
    parse: `return {};`,
    publish: `return JSON.stringify(value);`,
    publishSample: "配置中的多 Topic 指令组",
    config: [
      {
        key: "commands",
        label: "指令组（JSON: [{topic, payload}…]）",
        type: "textarea",
        def: `[{"topic":"light/bedroom/switch","payload":"ON"}]`,
      },
    ],
  },
  timerCard: {
    type: "timerCard",
    cat: "scene",
    labelKey: "dash.w.timerCard",
    w: 3,
    h: 2,
    vars: [
      { key: "next", type: "string", label: "next", desc: "下次执行时间" },
      { key: "countdown", type: "number", label: "countdown", desc: "剩余秒数（可选）" },
    ],
    template: `{ "next": "22:30", "countdown": 3660 }`,
    parse: `const data = JSON.parse(payload);
return { next: data.next ?? "", countdown: Number(data.countdown ?? 0) };`,
  },

  // ---- 信息展示 --------------------------------------------------------------
  textLabel: {
    type: "textLabel",
    cat: "info",
    labelKey: "dash.w.textLabel",
    w: 3,
    h: 1,
    vars: [{ key: "text", type: "string", label: "text", desc: "显示的文本" }],
    template: `{ "text": "客厅灯已打开" }`,
    parse: `const data = JSON.parse(payload);
return { text: data.text ?? data.msg ?? payload };`,
  },
  logList: {
    type: "logList",
    cat: "info",
    labelKey: "dash.w.logList",
    w: 6,
    h: 4,
    vars: [],
    template: `{}`,
    parse: `return {};`,
    config: [
      { key: "filter", label: "过滤关键词（留空全部）", type: "string", def: "" },
    ],
  },
  imageCard: {
    type: "imageCard",
    cat: "info",
    labelKey: "dash.w.imageCard",
    w: 3,
    h: 2,
    vars: [{ key: "src", type: "string", label: "src", desc: "图片 URL" }],
    template: `{ "url": "https://example.com/a.png" }`,
    parse: `const data = JSON.parse(payload);
return { src: data.url ?? data.src ?? "" };`,
    config: [{ key: "fallback", label: "默认图片 URL", type: "string", def: "" }],
  },
  divider: {
    type: "divider",
    cat: "info",
    labelKey: "dash.w.divider",
    w: 12,
    h: 1,
    vars: [],
    template: `{}`,
    parse: `return {};`,
  },
  clockCard: {
    type: "clockCard",
    cat: "info",
    labelKey: "dash.w.clockCard",
    w: 3,
    h: 2,
    vars: [],
    template: `{}`,
    parse: `return {};`,
  },

  // ---- 复合卡片 --------------------------------------------------------------
  lightCard: {
    type: "lightCard",
    cat: "composite",
    labelKey: "dash.w.lightCard",
    w: 4,
    h: 3,
    vars: [
      { key: "power", type: "boolean", label: "power", desc: "灯开关" },
      { key: "brightness", type: "number", label: "brightness", desc: "亮度 0-100" },
      { key: "temp", type: "number", label: "temp", desc: "色温 K（可选）" },
      { key: "color", type: "string", label: "color", desc: "颜色 #RRGGBB（可选）" },
    ],
    template: `{ "power": true, "brightness": 80, "temp": 4000, "color": "#FF8800" }`,
    parse: `const data = JSON.parse(payload);
return { power: data.power ?? false, brightness: Number(data.brightness ?? 0), temp: Number(data.temp ?? 0), color: data.color ?? "" };`,
    publish: `return JSON.stringify(value);`,
    publishSample: "{power,brightness,temp,color}",
  },
  acCard: {
    type: "acCard",
    cat: "composite",
    labelKey: "dash.w.acCard",
    w: 4,
    h: 3,
    vars: [
      { key: "power", type: "boolean", label: "power", desc: "空调开关" },
      { key: "mode", type: "string", label: "mode", desc: "模式 cool/heat/auto/fan" },
      { key: "temp", type: "number", label: "temp", desc: "设定温度" },
      { key: "fan", type: "number", label: "fan", desc: "风速 0-100" },
    ],
    template: `{ "power": true, "mode": "cool", "temp": 26, "fan": 60 }`,
    parse: `const data = JSON.parse(payload);
return { power: data.power ?? false, mode: data.mode ?? "auto", temp: Number(data.temp ?? 26), fan: Number(data.fan ?? 0) };`,
    publish: `return JSON.stringify(value);`,
    publishSample: "{power,mode,temp,fan}",
  },
  curtainCard: {
    type: "curtainCard",
    cat: "composite",
    labelKey: "dash.w.curtainCard",
    w: 4,
    h: 2,
    vars: [
      { key: "position", type: "number", label: "position", desc: "开合百分比 0-100（0=全关）" },
      { key: "moving", type: "string", label: "moving", desc: "状态 open/close/stop（可选）" },
    ],
    template: `{ "position": 30, "state": "open" }`,
    parse: `const data = JSON.parse(payload);
return { position: Number(data.position ?? 0), moving: data.state ?? "" };`,
    publish: `return JSON.stringify({ position: value.position, state: value.moving });`,
    publishSample: "{position:30,state:'open'}",
  },

  // ---- 图表类 ----------------------------------------------------------------
  lineChart: {
    type: "lineChart",
    cat: "chart",
    labelKey: "dash.w.lineChart",
    w: 6,
    h: 3,
    vars: [{ key: "series", type: "any", label: "series", desc: "多路数值对象 {temp: 26.3, humidity: 58}" }],
    template: `{ "temp": 26.3, "humidity": 58.4 }`,
    parse: `const data = JSON.parse(payload);
const out = {};
for (const k of Object.keys(data)) {
  const v = Number(data[k]);
  if (!Number.isNaN(v)) out[k] = v;
}
return { series: out };`,
    config: [
      { key: "maxPoints", label: "保留点数", type: "number", def: 60 },
      { key: "series", label: "显示序列（逗号分隔，空=全部）", type: "string", def: "" },
    ],
  },
  barChart: {
    type: "barChart",
    cat: "chart",
    labelKey: "dash.w.barChart",
    w: 6,
    h: 3,
    vars: [{ key: "values", type: "any", label: "values", desc: "数值对象或数组 {a: 10, b: 20}" }],
    template: `{ "a": 10, "b": 20, "c": 15 }`,
    parse: `const data = JSON.parse(payload);
return { values: data.values ?? data };`,
    config: [
      { key: "maxPoints", label: "保留点数", type: "number", def: 40 },
      { key: "series", label: "显示序列（逗号分隔，空=全部）", type: "string", def: "" },
    ],
  },

  // ---- 告警类 ----------------------------------------------------------------
  alarmLight: {
    type: "alarmLight",
    cat: "alarm",
    labelKey: "dash.w.alarmLight",
    w: 2,
    h: 1,
    vars: [
      { key: "triggered", type: "boolean", label: "triggered", desc: "是否触发告警" },
      { key: "value", type: "number", label: "value", desc: "当前值（用于阈值比较）" },
    ],
    template: `{ "value": 85 }`,
    parse: `const data = JSON.parse(payload);
const v = Number(data.value ?? data.v ?? 0);
return { triggered: data.triggered ?? v > 80, value: v };`,
    config: [{ key: "threshold", label: "阈值", type: "number", def: 80 }],
  },
  alarmPopup: {
    type: "alarmPopup",
    cat: "alarm",
    labelKey: "dash.w.alarmPopup",
    w: 3,
    h: 1,
    vars: [
      { key: "alarm", type: "boolean", label: "alarm", desc: "告警事件" },
      { key: "message", type: "string", label: "message", desc: "告警内容" },
    ],
    template: `{ "alarm": true, "message": "烟雾浓度过高" }`,
    parse: `const data = JSON.parse(payload);
return { alarm: data.alarm ?? false, message: data.message ?? data.msg ?? "" };`,
  },
};

export function widgetMeta(type: string): WidgetMeta | undefined {
  return WIDGETS[type];
}

/**
 * Out-of-the-box MQTT topics per widget type.
 *
 * - Widgets with both parse (subscribe) and publish get a `<state>` subscribe
 *   topic and a `<set>` publish topic.
 * - Display-only widgets get just a subscribe topic.
 * - Pure-local widgets (clock / divider) get none.
 *
 * Every topic below is globally unique across types so a fresh panel never has
 * two widgets fighting over the same topic. Users can freely edit/append these
 * in the widget settings drawer.
 */
export const PRESET_TOPICS: Record<string, { topics: string[]; pubTopic: string }> = {
  // 基础操作 (read/write)
  button: { topics: ["dev/button/state"], pubTopic: "dev/button/set" },
  toggle: { topics: ["dev/toggle/state"], pubTopic: "dev/toggle/set" },
  slider: { topics: ["dev/slider/state"], pubTopic: "dev/slider/set" },
  knob: { topics: ["dev/knob/state"], pubTopic: "dev/knob/set" },

  // 颜色 / 光效 (read/write)
  colorPicker: { topics: ["dev/color/state"], pubTopic: "dev/color/set" },
  colorTemp: { topics: ["dev/light/colortemp/state"], pubTopic: "dev/light/colortemp/set" },
  rgbInput: { topics: ["dev/rgb/state"], pubTopic: "dev/rgb/set" },

  // 数据显示 (display only)
  gauge: { topics: ["dev/gauge/value"], pubTopic: "" },
  numberText: { topics: ["dev/number/value"], pubTopic: "" },
  progress: { topics: ["dev/progress/value"], pubTopic: "" },
  battery: { topics: ["dev/battery/state"], pubTopic: "" },

  // 环境监测 (display only)
  tempCard: { topics: ["dev/env/temperature"], pubTopic: "" },
  humidityCard: { topics: ["dev/env/humidity"], pubTopic: "" },
  pm25Card: { topics: ["dev/env/pm25"], pubTopic: "" },
  envCard: { topics: ["dev/env"], pubTopic: "" },

  // 媒体控制 (read/write)
  mediaControls: { topics: ["dev/media/state"], pubTopic: "dev/media/control" },
  volumeSlider: { topics: ["dev/media/volume/state"], pubTopic: "dev/media/volume/set" },
  songInfo: { topics: ["dev/media/info"], pubTopic: "" },

  // 安防 / 门窗
  lockCard: { topics: ["dev/lock/state"], pubTopic: "dev/lock/set" },
  doorSensor: { topics: ["dev/security/door"], pubTopic: "" },
  motionSensor: { topics: ["dev/security/motion"], pubTopic: "" },
  cameraCard: { topics: ["dev/camera/snapshot"], pubTopic: "" },

  // 场景 / 自动化
  sceneButton: { topics: ["dev/scene/state"], pubTopic: "dev/scene/trigger" },
  timerCard: { topics: ["dev/timer/state"], pubTopic: "" },

  // 信息展示
  textLabel: { topics: ["dev/text/display"], pubTopic: "" },
  logList: { topics: ["dev/log/#"], pubTopic: "" },
  imageCard: { topics: ["dev/image/url"], pubTopic: "" },
  divider: { topics: [], pubTopic: "" },
  clockCard: { topics: [], pubTopic: "" },

  // 复合卡片 (read/write)
  lightCard: { topics: ["dev/light/state"], pubTopic: "dev/light/set" },
  acCard: { topics: ["dev/ac/state"], pubTopic: "dev/ac/set" },
  curtainCard: { topics: ["dev/curtain/state"], pubTopic: "dev/curtain/set" },

  // 图表类 (display only)
  lineChart: { topics: ["dev/chart/line"], pubTopic: "" },
  barChart: { topics: ["dev/chart/bar"], pubTopic: "" },

  // 告警类 (display only)
  alarmLight: { topics: ["dev/alarm/light"], pubTopic: "" },
  alarmPopup: { topics: ["dev/alarm/popup"], pubTopic: "" },
};
