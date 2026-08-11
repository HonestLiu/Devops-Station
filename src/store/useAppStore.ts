import { create } from "zustand";

import { db } from "@/lib/api";
import { registerImportedFonts } from "@/lib/fontLoader";
import { THEMES } from "@/lib/themes";
import type { AISettings, ThemeId } from "@/lib/types";

export type Page = "dashboard" | "hosts" | "monitoring" | "settings" | "sftp" | "serial" | "jlink";

export interface AppSettings {
  theme: ThemeId;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  copyOnSelect: boolean;
  /** Poll interval for the Monitoring page, in milliseconds. */
  metricsInterval: number;
  confirmOnClose: boolean;
  /** Default shell for Local Shell tabs. "default" uses the OS login shell. */
  localShell: string;
  /** Custom path to the J-Link executable (JLink.exe / JLinkExe). Empty = auto-detect. */
  jlinkPath: string;
  ai: AISettings;
  /** Families of user-imported fonts, re-registered at startup. */
  importedFonts: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "tokyo-night",
  fontFamily:
    '"JetBrainsMono Nerd Font", "JetBrains Mono", "MesloLGS NF", "Cascadia Code", Consolas, "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", monospace',
  fontSize: 13,
  lineHeight: 1.25,
  cursorBlink: true,
  cursorStyle: "block",
  scrollback: 10000,
  copyOnSelect: true,
  metricsInterval: 2000,
  confirmOnClose: true,
  localShell: "default",
  jlinkPath: "",
  importedFonts: [],
  ai: {
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o-mini",
    temperature: 0.3,
    terminalContext: true,
    errorHints: true,
    useKnowledgeBase: false,
    knowledgeBasePath: "",
  },
};

interface AppState {
  page: Page;
  paletteOpen: boolean;
  settings: AppSettings;
  settingsLoaded: boolean;

  setPage: (page: Page) => void;
  togglePalette: (open?: boolean) => void;
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
  root.style.setProperty("--font-mono", settings.fontFamily);
  root.style.setProperty("--terminal-font-size", `${settings.fontSize}px`);
  root.style.setProperty("--terminal-line-height", String(settings.lineHeight));
  applyWindowTheme(settings);
}

export const useAppStore = create<AppState>((set, get) => ({
  page: "dashboard",
  paletteOpen: false,
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,

  setPage: (page) => set({ page }),
  togglePalette: (open) =>
    set((s) => ({ paletteOpen: open === undefined ? !s.paletteOpen : open })),

  loadSettings: async () => {
    try {
      const stored = await db.getSettings();
      const merged = { ...DEFAULT_SETTINGS, ...(stored as Partial<AppSettings>) };
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
