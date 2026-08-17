/**
 * Parse / publish function executor for HMI widgets.
 *
 * User-edited code is a plain JS *body* (no `function` wrapper) compiled with
 * `new Function(...)`. `runParse` feeds it the raw payload + topic and demands
 * a plain-object return whose keys are exactly the widget's declared vars.
 */

export type ParseResult =
  | { ok: true; out: Record<string, unknown> }
  | { ok: false; error: string };

export function runParse(src: string, payload: string, topic: string): ParseResult {
  if (!src.trim()) return { ok: false, error: "解析函数为空" };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("payload", "topic", `"use strict";\n${src}`);
    const out = fn(payload, topic);
    if (typeof out !== "object" || out === null || Array.isArray(out)) {
      return { ok: false, error: "解析函数必须 return 一个对象（如 { temp: 26.3 }）" };
    }
    return { ok: true, out: out as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: describeError(e, src) };
  }
}

/** Run a publish fn body with `value`; returns the string payload to send. */
export function runPublish(src: string, value: unknown): { ok: true; out: string } | { ok: false; error: string } {
  if (!src.trim()) return { ok: false, error: "发布函数为空" };
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("value", `"use strict";\n${src}`);
    const out = fn(value);
    const s = typeof out === "string" ? out : JSON.stringify(out);
    return { ok: true, out: s };
  } catch (e) {
    return { ok: false, error: describeError(e, src) };
  }
}

/** Best-effort line number from a JS error thrown by `new Function` code. */
function describeError(e: unknown, src: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  // V8 reports "at <anonymous>:<line>:<col>" for code compiled via Function.
  const m = /:(\d+):\d+\)?/.exec(msg);
  if (m) {
    const line = Number(m[1]) - 1; // error line is 1-based, body starts at line 1
    const srcLine = src.split("\n")[line - 1]?.trim();
    return `${msg}${srcLine ? `\n第 ${line} 行：${srcLine.slice(0, 80)}` : ""}`;
  }
  return msg;
}

/** Decode a base64 MQTT payload to a UTF-8 string (lossy for binary). */
export function base64ToUtf8(b64: string): string {
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return b64;
  }
}

/** Encode a UTF-8 string payload to base64 (binary-safe for the backend). */
export function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Whether an MQTT topic matches a subscription filter (+ / # wildcards). */
export function topicMatches(topic: string, filter: string): boolean {
  const t = topic.split("/");
  const f = filter.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] === "+") continue;
    if (f[i] !== t[i]) return false;
  }
  return t.length === f.length;
}

/** Is `topic` covered by any of the given subscribe topics? */
export function topicCovered(topic: string, topics: string[]): boolean {
  return topics.some((f) => f.trim() && topicMatches(topic, f.trim()));
}
