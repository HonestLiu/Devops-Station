import { useAppStore } from "@/store/useAppStore";
import { THEMES } from "@/lib/themes";

/**
 * CJK fallback appended to the user's terminal font so Chinese / Japanese / Korean
 * output (and AI replies) renders instead of tofu boxes. The primary monospace font
 * is almost always ASCII-only (Consolas, JetBrains Mono, Nerd Fonts…), so without
 * this, non-ASCII glyphs fall through to missing-glyph boxes on Windows.
 */
const CJK_FALLBACK =
  ', "Microsoft YaHei", "Microsoft YaHei Mono", "PingFang SC", "Noto Sans CJK SC", "Sarasa Term SC", monospace';

/**
 * Derives the live xterm theme + typography from global settings. Re-renders
 * whenever the user changes the theme or terminal preferences.
 */
export function useTerminalTheme() {
  const settings = useAppStore((s) => s.settings);
  // Append CJK fallbacks once (guarded so re-renders don't grow the string).
  const fontFamily = settings.fontFamily.includes("YaHei")
    ? settings.fontFamily
    : settings.fontFamily + CJK_FALLBACK;
  return {
    theme: THEMES[settings.theme].terminal,
    cursorColor: settings.cursorColor,
    cursorInactiveStyle: settings.cursorInactiveStyle,
    fontFamily,
    fontSize: settings.fontSize,
    lineHeight: settings.lineHeight,
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    scrollback: settings.scrollback,
  };
}
