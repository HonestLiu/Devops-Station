import { useCallback } from "react";

import { useAppStore, type Language } from "@/store/useAppStore";
import { zh } from "./zh";
import { en } from "./en";

export type { Language };
export type TKey = keyof typeof zh;

/** Translate a key into the given language, substituting `{name}` placeholders. */
export function tFrom(
  lang: Language,
  key: TKey,
  params?: Record<string, string | number>,
): string {
  const dict: Record<TKey, string> = lang === "zh" ? zh : en;
  let s = dict[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/**
 * Reactive translate hook. Re-renders the component when the app language
 * changes (it subscribes to `settings.language`).
 */
export function useT() {
  const lang = useAppStore((s) => s.settings.language);
  return useCallback(
    (key: TKey, params?: Record<string, string | number>) => tFrom(lang, key, params),
    [lang],
  );
}
