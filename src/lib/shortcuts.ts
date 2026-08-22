import { isMac } from "@/lib/platform";
import type { TKey } from "@/i18n";
import type { ShortcutBinding, ShortcutId, ShortcutSettings } from "@/lib/types";

/**
 * Registry of every configurable keyboard shortcut. This is the single source
 * of truth for: the Settings list (label/desc/default), the app-wide dispatch
 * (App.tsx), and the persisted settings shape (useAppStore / sync).
 *
 * Defaults are platform-aware: the primary-modifier shortcuts use `meta` on
 * macOS and `ctrl` elsewhere, matching the previous hardcoded Cmd/Ctrl behavior.
 */
export interface ShortcutDef {
  id: ShortcutId;
  /** i18n key for the action label. */
  labelKey: TKey;
  /** i18n key for the description. */
  descKey: TKey;
  defaultSpec: string;
  /** True for shortcuts that are also registered as an OS-level global hotkey
   *  (currently only quickApprove). */
  global?: boolean;
}

export const SHORTCUT_DEFS: ShortcutDef[] = [
  {
    id: "quickApprove",
    labelKey: "settings.approveShortcut",
    descKey: "settings.approveShortcutHint",
    defaultSpec: "ctrl+shift+Enter",
    global: true,
  },
  {
    id: "toggleAi",
    labelKey: "settings.shortcutToggleAi",
    descKey: "settings.shortcutToggleAiHint",
    defaultSpec: isMac ? "meta+Period" : "ctrl+Period",
  },
  {
    id: "togglePalette",
    labelKey: "settings.shortcutTogglePalette",
    descKey: "settings.shortcutTogglePaletteHint",
    defaultSpec: isMac ? "meta+KeyK" : "ctrl+KeyK",
  },
  {
    id: "splitPaneCol",
    labelKey: "settings.shortcutSplitPaneCol",
    descKey: "settings.shortcutSplitPaneColHint",
    defaultSpec: "ctrl+shift+KeyD",
  },
  {
    id: "splitPaneRow",
    labelKey: "settings.shortcutSplitPaneRow",
    descKey: "settings.shortcutSplitPaneRowHint",
    defaultSpec: "ctrl+shift+KeyE",
  },
  {
    id: "closePane",
    labelKey: "settings.shortcutClosePane",
    descKey: "settings.shortcutClosePaneHint",
    defaultSpec: "ctrl+shift+KeyW",
  },
  {
    id: "focusPaneLeft",
    labelKey: "settings.shortcutFocusPaneLeft",
    descKey: "settings.shortcutFocusPaneLeftHint",
    defaultSpec: "ctrl+shift+ArrowLeft",
  },
  {
    id: "focusPaneRight",
    labelKey: "settings.shortcutFocusPaneRight",
    descKey: "settings.shortcutFocusPaneRightHint",
    defaultSpec: "ctrl+shift+ArrowRight",
  },
  {
    id: "focusPaneUp",
    labelKey: "settings.shortcutFocusPaneUp",
    descKey: "settings.shortcutFocusPaneUpHint",
    defaultSpec: "ctrl+shift+ArrowUp",
  },
  {
    id: "focusPaneDown",
    labelKey: "settings.shortcutFocusPaneDown",
    descKey: "settings.shortcutFocusPaneDownHint",
    defaultSpec: "ctrl+shift+ArrowDown",
  },
];

/** Default bindings (every shortcut enabled at its platform default). */
export function defaultShortcutBindings(): ShortcutSettings {
  const out = {} as ShortcutSettings;
  for (const d of SHORTCUT_DEFS) out[d.id] = { spec: d.defaultSpec, enabled: true };
  return out;
}

/**
 * Field-by-field merge so a partial, corrupt, or legacy `shortcuts` object can
 * never clobber the rest of the registry — every id falls back to `fallback`.
 */
export function mergeShortcutSettings(
  stored: Partial<ShortcutSettings> | undefined,
  fallback: ShortcutSettings = defaultShortcutBindings(),
): ShortcutSettings {
  const out: ShortcutSettings = { ...fallback };
  if (stored && typeof stored === "object") {
    for (const d of SHORTCUT_DEFS) {
      const r = stored[d.id];
      if (r && typeof r === "object") {
        out[d.id] = {
          spec: typeof r.spec === "string" && r.spec ? r.spec : fallback[d.id].spec,
          enabled: typeof r.enabled === "boolean" ? r.enabled : fallback[d.id].enabled,
        };
      }
    }
  }
  return out;
}

/** Whether a shortcut id drives the terminal split/close/focus actions. */
export function isSplitShortcut(id: ShortcutId): boolean {
  return (
    id === "splitPaneCol" ||
    id === "splitPaneRow" ||
    id === "closePane" ||
    id === "focusPaneLeft" ||
    id === "focusPaneRight" ||
    id === "focusPaneUp" ||
    id === "focusPaneDown"
  );
}

/** Reference to a default binding for a single id (used by Settings reset). */
export function defaultBinding(id: ShortcutId): ShortcutBinding {
  const d = SHORTCUT_DEFS.find((x) => x.id === id);
  return d ? { spec: d.defaultSpec, enabled: true } : { spec: "", enabled: true };
}
