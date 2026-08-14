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
