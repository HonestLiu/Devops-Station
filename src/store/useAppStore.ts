import { create } from "zustand";

import { db } from "@/lib/api";
import { registerImportedFonts } from "@/lib/fontLoader";
import { THEMES } from "@/lib/themes";
import { defaultShortcutBindings, mergeShortcutSettings } from "@/lib/shortcuts";
import type { SyncConfig, AISettings, ApprovalSettings, KeywordHighlightSettings, ShortcutSettings, ThemeId } from "@/lib/types";

export type Page = "dashboard" | "hosts" | "monitoring" | "settings" | "sftp" | "serial" | "jlink" | "mqtt";

export type Language = "zh" | "en";

/** OS/browser locale → default app language: zh-* → Chinese, else English. */
function detectLanguage(): Language {
  if (typeof navigator === "undefined") return "en";
  return /^zh/i.test(navigator.language || "") ? "zh" : "en";
}

export interface AppSettings {
  theme: ThemeId;
  /** UI + AI answer language. */
  language: Language;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  /** Custom terminal cursor color (hex). Empty = follow the active theme. */
  cursorColor: string;
  /** Cursor shape when the terminal is unfocused (xterm supports "outline"
   *  only here — a fun extra shape not available for the focused cursor). */
  cursorInactiveStyle: "block" | "outline" | "bar";
  scrollback: number;
  /** Render inline images sent by the remote (SIXEL / iTerm2 imgcat). */
  inlineImages: boolean;
  /** Terminal keyword-highlight rules (global; per-host rules merge on top). */
  keywordHighlight: KeywordHighlightSettings;
  copyOnSelect: boolean;
  /** Poll interval for the Monitoring page, in milliseconds. */
  metricsInterval: number;
  confirmOnClose: boolean;
  /** Default shell for Local Shell tabs. "default" uses the OS login shell. */
  localShell: string;
  /** Custom path to the J-Link executable (JLink.exe / JLinkExe). Empty = auto-detect. */
  jlinkPath: string;
  /** Whether the left sidebar is collapsed to icon-only. */
  sidebarCollapsed: boolean;
  ai: AISettings;
  /** Families of user-imported fonts, re-registered at startup. */
  importedFonts: string[];
  /** All configurable keyboard shortcuts (registry in src/lib/shortcuts.ts). */
  shortcuts: ShortcutSettings;
  /** Whether to raise native OS notifications for agent/CLI approval prompts. */
  approvalNotifications: boolean;
  /** HOOK-based approval detection (primary) + legacy scan compat switch. */
  approval: ApprovalSettings;
  /** Check GitHub Releases for a newer version a few seconds after launch. */
  autoCheckUpdates: boolean;
  /** When a newer version is found during the automatic startup check, download
   *  and install it without waiting for the user to click "Update now".
   *  Manual checks always show the release notes first. */
  autoDownloadUpdates: boolean;
  /** GitHub mirror used to accelerate update downloads. A URL *prefix* applied
   *  to the asset download URL (e.g. `https://github.dpik.top`). Empty = fetch
   *  directly from GitHub. */
  githubMirror: string;
  /** User's display name — synced across devices as identity info. */
  username: string;
  /** User's avatar as a data: URL — synced across devices as identity info. */
  avatar: string;
  /** Object-storage sync configuration (local credentials, not synced). */
  sync: SyncConfig;
  /** Per-feature toolbar visibility. When a feature is off, its toolbar
   *  button is hidden and any open panel is force-closed (unmounting it and
   *  stopping its work). */
  features: FeatureSettings;
  /** Desktop pet (ChatGPT-Desktop-style companion) settings. */
  pet: PetSettings;
  /** Show a confirmation dialog before the app quits (window close, Alt+F4,
   *  taskbar right-click → Close). When off, the window closes immediately.
   *  Default true so a stray close doesn't lose unsaved work. */
  confirmOnExit: boolean;
}

/** Persisted desktop-pet configuration. */
export interface PetSettings {
  /** Whether the pet overlay window is enabled. */
  enabled: boolean;
  /** Selected pet id (must exist in public/pets/manifest.json). */
  petId: string;
  /** Sprite scale multiplier (0.5 – 2.5). */
  scale: number;
  /** React to the AI agent status (perm-state-changed). */
  reactToAi: boolean;
  /** When true the pet stays at a fixed position instead of wandering. */
  stayPut: boolean;
}

/** Which toolbar panels/features are enabled. */
export interface FeatureSettings {
  /** File browser (SFTP / WSL / local) panel. */
  files: boolean;
  /** Git panel. */
  git: boolean;
  /** Docker panel. */
  docker: boolean;
  /** Snippets panel. */
  snippets: boolean;
  /** Port forwarding panel (SSH workspaces only). */
  portForward: boolean;
  /** WSL USB / USB/IP attach panel (WSL workspaces only). */
  usb: boolean;
  /** Known Hosts dialog (SSH workspaces only). */
  knownHosts: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "tokyo-night",
  language: detectLanguage(),
  // Monospace-only stack: on macOS/Linux the old stack (JetBrains Mono …
  // Consolas …) fell through to the proportional CJK fonts (PingFang SC /
  // Microsoft YaHei / Noto Sans CJK SC), rendering the whole terminal in a
  // wide proportional font whenever the leading monospace fonts weren't
  // installed. CJK glyphs still render via the browser's per-glyph fallback.
  fontFamily:
    '"JetBrains Mono", "JetBrainsMono Nerd Font", "SF Mono", Menlo, Monaco, "Cascadia Mono", Consolas, "DejaVu Sans Mono", "Ubuntu Mono", monospace',
  fontSize: 13,
  lineHeight: 1.25,
  cursorBlink: true,
  cursorStyle: "block",
  cursorColor: "",
  cursorInactiveStyle: "block",
  scrollback: 10000,
  inlineImages: true,
  keywordHighlight: {
    enabled: true,
    rules: [
      { id: "kh-error", pattern: "error|fail|failed|exception|fatal|panic|denied|refused", color: "#ff5555", wholeLine: true, enabled: true },
      { id: "kh-warn", pattern: "warn|warning|deprecated|timeout", color: "#ffb86c", wholeLine: true, enabled: true },
      { id: "kh-ok", pattern: "success|succeeded|\\bok\\b|done|ready|listening|started", color: "#50fa7b", wholeLine: true, enabled: true },
      { id: "kh-ip", pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b", color: "#8be9fd", wholeLine: false, enabled: true },
    ],
  },
  copyOnSelect: true,
  metricsInterval: 2000,
  confirmOnClose: true,
  localShell: "default",
  jlinkPath: "",
  sidebarCollapsed: false,
  importedFonts: [],
  shortcuts: defaultShortcutBindings(),
  approvalNotifications: true,
  approval: {
    enabled: true,
    port: 47890,
    tools: { claude: true, codex: true, opencode: true },
    scanFallback: false,
  },
  autoCheckUpdates: true,
  autoDownloadUpdates: false,
  githubMirror: "",
  username: "",
  avatar: "",
  sync: {
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    accessKeyId: "",
    secretAccessKey: "",
    prefix: "",
    pathStyle: false,
    includeSecrets: true,
    lastSyncAt: 0,
  },
  features: {
    files: true,
    git: true,
    docker: true,
    snippets: true,
    portForward: true,
    usb: true,
    knownHosts: true,
  },
  pet: {
    enabled: false,
    petId: "professor-hoot",
    scale: 1,
    reactToAi: true,
    stayPut: false,
  },
  confirmOnExit: true,
  ai: {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    temperature: 0.3,
    terminalContext: true,
    errorHints: true,
    autoDiagnose: true,
    useKnowledgeBase: false,
    knowledgeBasePath: "",
    // Keep the model's native behavior by default; opt in for faster replies.
    disableThinking: false,
  },
};

interface AppState {
  page: Page;
  paletteOpen: boolean;
  /** Whether the desktop-pet settings panel is open. */
  petPanelOpen: boolean;
  settings: AppSettings;
  settingsLoaded: boolean;

  setPage: (page: Page) => void;
  togglePalette: (open?: boolean) => void;
  setPetPanelOpen: (open: boolean) => void;
  loadSettings: () => Promise<void>;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  resetSettings: () => Promise<void>;
}

/**
 * Sync the native window chrome (title bar / frame) with the UI theme. Tauri
 * defaults to a dark frame otherwise, which looks wrong against the light
 * theme. Fire-and-forget: in a plain browser (vite dev) the call just fails.
 */
function applyWindowTheme(settings: AppSettings) {
  const dark = THEMES[settings.theme]?.dark ?? true;
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().setTheme(dark ? "dark" : "light"),
    )
    .catch(() => undefined);
}

/** Applies theme + typography to the document so CSS variables stay the single source of truth. */
function applySettings(settings: AppSettings) {
  const root = document.documentElement;
  root.setAttribute("data-theme", settings.theme);
  root.lang = settings.language;
  root.style.setProperty("--font-mono", settings.fontFamily);
  root.style.setProperty("--terminal-font-size", `${settings.fontSize}px`);
  root.style.setProperty("--terminal-line-height", String(settings.lineHeight));
  applyWindowTheme(settings);
}

/**
 * The pre-2026-08 terminal font stack ended in proportional CJK fonts
 * (PingFang SC / Microsoft YaHei / Noto Sans CJK SC). On systems without the
 * leading monospace fonts (e.g. macOS) that made the whole terminal render in
 * a wide proportional font. We detect and replace the exact legacy value so
 * installs that already persisted it heal automatically.
 */
const LEGACY_TERMINAL_FONT_STACK =
  '"JetBrainsMono Nerd Font", "JetBrains Mono", "MesloLGS NF", "Cascadia Code", Consolas, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace';

function repairFontFamily(family: string): string {
  return family === LEGACY_TERMINAL_FONT_STACK ? DEFAULT_SETTINGS.fontFamily : family;
}

export const useAppStore = create<AppState>((set, get) => ({
  page: "dashboard",
  paletteOpen: false,
  petPanelOpen: false,
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,

  setPage: (page) => set({ page }),
  togglePalette: (open) =>
    set((s) => ({ paletteOpen: open === undefined ? !s.paletteOpen : open })),
  setPetPanelOpen: (open) => set({ petPanelOpen: open }),

  loadSettings: async () => {
    try {
      const stored = await db.getSettings();
      // Legacy migration: the pre-object-storage "account" (Python-server auth)
      // key is obsolete — drop it so a stale `account` blob can't linger on top
      // of the new `sync` config after the shallow spread below.
      const legacyStored = { ...(stored as Partial<AppSettings>) };
      delete (legacyStored as Record<string, unknown>).account;
      // Legacy migration: pre-registry builds persisted flat `approveShortcut` /
      // `approveShortcutEnabled` (removed from AppSettings). Seed `quickApprove`
      // from them; a persisted `shortcuts` object wins field-by-field over the
      // seed.
      const migrated = defaultShortcutBindings();
      const legacy = stored as Partial<AppSettings> & {
        approveShortcut?: string;
        approveShortcutEnabled?: boolean;
      };
      if (legacy.approveShortcut) {
        migrated.quickApprove = {
          spec: legacy.approveShortcut,
          enabled: legacy.approveShortcutEnabled ?? migrated.quickApprove.enabled,
        };
      }
      const merged = {
        ...DEFAULT_SETTINGS,
        ...legacyStored,
        // `ai` is a nested object — a shallow spread would let a persisted `ai`
        // object from an older build (one that predates fields like
        // `autoDiagnose`, `knowledgeBase`, …) clobber the whole subtree, leaving
        // the new keys `undefined` (falsy) and silently disabling features that
        // the user never turned off. Merge field-by-field so every key falls
        // back to its default.
        ai: { ...DEFAULT_SETTINGS.ai, ...((stored as Partial<AppSettings>).ai ?? {}) },
        // `approval` is a doubly-nested object (tools) — merge field-by-field
        // so a persisted older `approval` shape can never clobber new keys.
        approval: {
          ...DEFAULT_SETTINGS.approval,
          ...((stored as Partial<AppSettings>).approval ?? {}),
          tools: {
            ...DEFAULT_SETTINGS.approval.tools,
            ...(((stored as Partial<AppSettings>).approval as ApprovalSettings | undefined)?.tools ?? {}),
          },
        },
        // `keywordHighlight` is a nested object (rules) — merge so an older
        // persisted shape can't drop the default rules.
        keywordHighlight: {
          ...DEFAULT_SETTINGS.keywordHighlight,
          ...((stored as Partial<AppSettings>).keywordHighlight ?? {}),
        },
        // `shortcuts` is a per-id record — merge against the legacy-seeded
        // defaults so a partial/older shape can't drop the other bindings.
        shortcuts: mergeShortcutSettings(
          (stored as Partial<AppSettings>).shortcuts,
          migrated,
        ),
        // `sync` is a nested object — merge field-by-field so a persisted older
        // shape (e.g. before `includeSecrets` existed) can never drop keys.
        sync: {
          ...DEFAULT_SETTINGS.sync,
          ...((stored as Partial<AppSettings>).sync ?? {}),
        },
        // `features` is a nested object — merge field-by-field so a persisted
        // older shape can never drop the other toggles.
        features: {
          ...DEFAULT_SETTINGS.features,
          ...((stored as Partial<AppSettings>).features ?? {}),
        },
        // `pet` is a nested object — merge field-by-field.
        pet: {
          ...DEFAULT_SETTINGS.pet,
          ...((stored as Partial<AppSettings>).pet ?? {}),
        },
        // `confirmOnExit` is a plain boolean — fall back to the default so an
        // older settings blob (pre-this-feature) still gets the safe default.
        confirmOnExit:
          typeof (stored as Partial<AppSettings>).confirmOnExit === "boolean"
            ? (stored as Partial<AppSettings>).confirmOnExit!
            : DEFAULT_SETTINGS.confirmOnExit,
      };
      merged.fontFamily = repairFontFamily(merged.fontFamily);
      // Persist the repair so it isn't re-detected on every startup.
      if (merged.fontFamily !== (stored as Partial<AppSettings>).fontFamily) {
        void db.setSetting("fontFamily", merged.fontFamily).catch(() => undefined);
      }
      // Persist the migrated `shortcuts` once so the legacy flat keys are
      // superseded by the nested object on the next write.
      void db.setSetting("shortcuts", merged.shortcuts).catch(() => undefined);
      applySettings(merged);
      set({ settings: merged, settingsLoaded: true });
      // Re-register any fonts the user previously imported.
      void registerImportedFonts(merged.importedFonts ?? []);
    } catch {
      // A missing/corrupt settings table must never block startup.
      applySettings(DEFAULT_SETTINGS);
      set({ settingsLoaded: true });
    }
  },

  updateSetting: async (key, value) => {
    const settings = { ...get().settings, [key]: value };
    applySettings(settings);
    set({ settings });
    await db.setSetting(key as string, value).catch(() => undefined);
  },

  resetSettings: async () => {
    applySettings(DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });
    await Promise.all(
      Object.entries(DEFAULT_SETTINGS).map(([k, v]) =>
        db.setSetting(k, v).catch(() => undefined),
      ),
    );
  },
}));
