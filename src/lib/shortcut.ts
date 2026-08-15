/**
 * Global shortcut helpers: parse a "modifier+key" spec (e.g. "ctrl+shift+Enter")
 * and match it against a KeyboardEvent. Used by configurable app-level
 * shortcuts like quick-approve (Settings → Shortcuts).
 */

export interface Shortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** KeyboardEvent.code, e.g. "Enter", "KeyK", "Period". */
  code: string;
}

/** KeyboardEvent.code values for the modifier keys themselves. */
export const MODIFIER_CODES = new Set(["Control", "Shift", "Alt", "Meta"]);

/** Parse "ctrl+shift+Enter" → Shortcut. Loose on case and separator order. */
export function parseShortcut(spec: string): Shortcut | null {
  if (!spec) return null;
  const parts = spec
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase());

  // Map common key aliases to KeyboardEvent.code.
  let code = key;
  const lower = key.toLowerCase();
  const CODE_ALIASES: Record<string, string> = {
    enter: "Enter",
    return: "Enter",
    space: "Space",
    spacebar: "Space",
    tab: "Tab",
    esc: "Escape",
    escape: "Escape",
    backspace: "Backspace",
    delete: "Delete",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    pageup: "PageUp",
    pagedown: "PageDown",
    home: "Home",
    end: "End",
    insert: "Insert",
    "?": "Slash",
    ".": "Period",
    "/": "Slash",
    ",": "Comma",
    ";": "Semicolon",
    "'": "Quote",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    "-": "Minus",
    "=": "Equal",
    "`": "Backquote",
  };
  if (CODE_ALIASES[lower]) {
    code = CODE_ALIASES[lower];
  } else if (/^[a-z0-9]$/i.test(key)) {
    // Single letter/digit → "KeyA".."KeyZ" / "Digit0".."Digit9".
    code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : `Digit${key}`;
  } else if (/^f\d{1,2}$/i.test(key)) {
    code = `F${lower.slice(1)}`;
  }

  // A shortcut whose "key" is itself a modifier (e.g. "ctrl+Control", produced
  // by a buggy recorder that captured the modifier keydown instead of ignoring
  // it) is nonsensical — never let it match. This neutralizes a corrupted spec
  // like "ctrl+Control" that would otherwise fire on every bare Ctrl keydown.
  if (MODIFIER_CODES.has(code)) return null;

  return {
    ctrl: mods.includes("ctrl") || mods.includes("control"),
    shift: mods.includes("shift"),
    alt: mods.includes("alt") || mods.includes("option"),
    meta: mods.includes("meta") || mods.includes("cmd") || mods.includes("win") || mods.includes("super"),
    code,
  };
}

/** Whether a keydown event matches the spec. */
export function matchesShortcut(e: KeyboardEvent, spec: string): boolean {
  const s = parseShortcut(spec);
  if (!s) return false;
  return (
    e.ctrlKey === s.ctrl &&
    e.shiftKey === s.shift &&
    e.altKey === s.alt &&
    e.metaKey === s.meta &&
    e.code === s.code
  );
}

/** Pretty display, e.g. "Ctrl + Shift + Enter" (ordered Ctrl Alt Shift Meta Key). */
export function formatShortcut(spec: string): string {
  const s = parseShortcut(spec);
  if (!s) return spec || "";
  const mods: string[] = [];
  if (s.ctrl) mods.push("Ctrl");
  if (s.alt) mods.push("Alt");
  if (s.shift) mods.push("Shift");
  if (s.meta) mods.push("Cmd");
  let key = s.code;
  const CODE_NAMES: Record<string, string> = {
    Enter: "Enter",
    Space: "Space",
    Tab: "Tab",
    Escape: "Esc",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    PageUp: "PgUp",
    PageDown: "PgDn",
    Home: "Home",
    End: "End",
    Insert: "Ins",
    Slash: "/",
    Period: ".",
    Comma: ",",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
  };
  if (CODE_NAMES[key]) key = CODE_NAMES[key];
  else if (key.startsWith("Key")) key = key.slice(3);
  else if (key.startsWith("Digit")) key = key.slice(5);
  return [...mods, key].join(" + ");
}

/**
 * Whether a shortcut is being recorded in Settings right now. While true, the
 * app-level shortcut handlers (quick-approve, palette, AI panel) must stand
 * down: they are registered on `window` in the capture phase *before* the
 * recorder's own listener, and a matching combination would otherwise
 * `stopPropagation` and swallow the keystroke the recorder is trying to read.
 */
let recordingShortcut = false;

export function setShortcutRecording(v: boolean): void {
  recordingShortcut = v;
}

export function isShortcutRecording(): boolean {
  return recordingShortcut;
}

/**
 * Normalize a front-end shortcut spec ("ctrl+shift+Enter", KeyboardEvent.code
 * based) into the accelerator string the OS-level global-shortcut plugin
 * accepts ("Ctrl+Shift+Enter"). Returns null when the spec has no key.
 */
export function shortcutToAccelerator(spec: string): string | null {
  const s = parseShortcut(spec);
  if (!s || !s.code) return null;
  const mods: string[] = [];
  if (s.ctrl) mods.push("Ctrl");
  if (s.alt) mods.push("Alt");
  if (s.shift) mods.push("Shift");
  if (s.meta) mods.push("Super");
  // KeyboardEvent.code → accelerator key name.
  const KEY_NAMES: Record<string, string> = {
    Enter: "Enter",
    Space: "Space",
    Tab: "Tab",
    Escape: "Esc",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Home: "Home",
    End: "End",
    Insert: "Insert",
    Slash: "/",
    Period: ".",
    Comma: ",",
    Semicolon: ";",
    Quote: "'",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Minus: "-",
    Equal: "=",
    Backquote: "`",
  };
  let key = KEY_NAMES[s.code];
  if (!key) {
    if (s.code.startsWith("Key")) key = s.code.slice(3);
    else if (s.code.startsWith("Digit")) key = s.code.slice(5);
    else if (/^F\d{1,2}$/.test(s.code)) key = s.code;
    else return null;
  }
  return [...mods, key].join("+");
}
