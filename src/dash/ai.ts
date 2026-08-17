import { streamChat } from "@/ai/client";
import { currentProvider, hasAiConfig } from "@/ai/useAiStore";
import type { WidgetMeta } from "./registry";

export { hasAiConfig };

export interface AiCallHandlers {
  onDelta: (text: string) => void;
  onDone: (full: string) => void;
  onError: (err: string) => void;
}

/**
 * Ask the global AI to write a parse function body for a widget.
 * `instruction` is an optional follow-up tweak ("把温度从华氏转摄氏").
 */
export function aiGenerateParse(
  meta: WidgetMeta,
  samplePayload: string,
  instruction: string | undefined,
  handlers: AiCallHandlers,
): { cancel: () => void } {
  const varsDesc = meta.vars
    .map((v) => `${v.key} (${v.type})：${v.desc}`)
    .join("\n");
  const user = [
    `请为 MQTT 智能家居仪表盘控件「${meta.labelKey}」编写一个 JavaScript 解析函数体。`,
    ``,
    `控件需要的显示位变量（必须全部返回，只能返回这些键）：`,
    varsDesc || "（无显示位变量，返回空对象即可）",
    ``,
    `设备上报的原始 MQTT payload 示例（可能是 JSON、纯文本或数字）：`,
    `\`\`\``,
    samplePayload || "（尚未收到数据）",
    `\`\`\``,
    ``,
    instruction ? `用户的额外要求：${instruction}` : "",
    ``,
    `要求：`,
    `1. 只输出函数体本身（会被包装成 new Function("payload","topic", body) 执行），不要输出 function 声明、不要 js 代码块标记、不要解释文字。`,
    `2. payload 是原始字符串，topic 是订阅主题；用 try/catch 容错，解析失败返回默认值。`,
    `3. 必须 return 一个对象，键只能是上面列出的显示位变量。`,
  ]
    .filter((l) => l !== undefined)
    .join("\n");

  let acc = "";
  return streamChat(
    {
      provider: currentProvider(),
      messages: [
        {
          role: "user",
          content:
            "你是一个嵌入式/MQTT 数据解析专家，只输出可直接运行的 JavaScript 函数体。",
        },
        { role: "user", content: user },
      ],
    },
    {
      onDelta: (delta) => {
        acc += delta;
        handlers.onDelta(delta);
      },
      onDone: (err) => {
        if (err) handlers.onError(err);
        else handlers.onDone(stripFence(acc));
      },
    },
  );
}

/** Remove ```js …``` fences and leading/trailing blank lines AI often adds. */
function stripFence(code: string): string {
  return code
    .replace(/^```(?:js|javascript)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}
