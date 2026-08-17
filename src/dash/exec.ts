/**
 * Parse / publish function executor for HMI widgets.
 *
 * User-edited code is a plain JS *body* (no `function` wrapper). It is executed
 * in a sandboxed QuickJS runtime on the Rust side via the `dash_eval` command,
 * so the webview itself never runs `new Function` — this keeps the frontend CSP
 * strict (no `unsafe-eval`) and removes a whole class of CSP errors.
 */

import { invoke } from "@tauri-apps/api/core";

export type ParseResult =
  | { ok: true; out: Record<string, unknown> }
  | { ok: false; error: string };

type EvalResp = { ok: true; out: unknown } | { ok: false; error: string };

/** Evaluate a parse fn body with `payload` + `topic`; returns a vars object. */
export async function runParse(src: string, payload: string, topic: string): Promise<ParseResult> {
  if (!src.trim()) return { ok: false, error: "解析函数为空" };
  try {
    const res = await invoke<EvalResp>("dash_eval", { kind: "parse", code: src, payload, topic });
    if (res.ok) return { ok: true, out: (res.out as Record<string, unknown>) ?? {} };
    return { ok: false, error: res.error ?? "未知错误" };
  } catch (e) {
    return { ok: false, error: describeError(e, src) };
  }
}

/** Evaluate a publish fn body with `value`; returns the string payload to send. */
export async function runPublish(
  src: string,
  value: unknown,
): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  if (!src.trim()) return { ok: false, error: "发布函数为空" };
  try {
    const res = await invoke<EvalResp>("dash_eval", {
      kind: "publish",
      code: src,
      value: JSON.stringify(value ?? null),
    });
    if (res.ok) return { ok: true, out: String(res.out ?? "") };
    return { ok: false, error: res.error ?? "未知错误" };
  } catch (e) {
    return { ok: false, error: describeError(e, src) };
  }
}

/** Best-effort line number from a JS error thrown by the sandbox. */
function describeError(e: unknown, src: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  // QuickJS (and V8) report "at <anonymous>:<line>:<col>" for Function-style code.
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
