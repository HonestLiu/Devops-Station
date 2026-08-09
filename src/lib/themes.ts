import type { ITheme } from "@xterm/xterm";
import type { ThemeId } from "./types";

export interface ThemeDefinition {
  id: ThemeId;
  label: string;
  /** Used for the swatch in Settings. */
  swatch: [string, string, string];
  dark: boolean;
  terminal: ITheme;
}

/**
 * xterm needs literal colours, not CSS variables, so each UI theme ships a
 * matching 16-colour ANSI palette. Keep these in sync with `globals.css`.
 */
export const THEMES: Record<ThemeId, ThemeDefinition> = {
  "tokyo-night": {
    id: "tokyo-night",
    label: "Tokyo Night",
    swatch: ["#1a1b26", "#7aa2f7", "#9ece6a"],
    dark: true,
    terminal: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },

  dark: {
    id: "dark",
    label: "Dark",
    swatch: ["#1e1e1e", "#0a84ff", "#4ec9b0"],
    dark: true,
    terminal: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
      cursor: "#d4d4d4",
      cursorAccent: "#1e1e1e",
      selectionBackground: "#264f78",
      black: "#000000",
      red: "#cd3131",
      green: "#0dbc79",
      yellow: "#e5e510",
      blue: "#2472c8",
      magenta: "#bc3fbc",
      cyan: "#11a8cd",
      white: "#e5e5e5",
      brightBlack: "#666666",
      brightRed: "#f14c4c",
      brightGreen: "#23d18b",
      brightYellow: "#f5f543",
      brightBlue: "#3b8eea",
      brightMagenta: "#d670d6",
      brightCyan: "#29b8db",
      brightWhite: "#ffffff",
    },
  },

  light: {
    id: "light",
    label: "Light",
    swatch: ["#ffffff", "#0969da", "#1a7f37"],
    dark: false,
    terminal: {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#24292f",
      cursorAccent: "#ffffff",
      selectionBackground: "#b6d7ff",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#633c01",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    },
  },

  nord: {
    id: "nord",
    label: "Nord",
    swatch: ["#2e3440", "#88c0d0", "#a3be8c"],
    dark: true,
    terminal: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },

  dracula: {
    id: "dracula",
    label: "Dracula",
    swatch: ["#282a36", "#bd93f9", "#50fa7b"],
    dark: true,
    terminal: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
};

export const THEME_LIST = Object.values(THEMES);

/** Read a live CSS variable as `#rrggbb`, for canvas-based widgets. */
export function cssColor(name: string, alpha = 1): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(`--c-${name}`)
    .trim();
  if (!raw) return "#888888";
  return alpha === 1 ? `rgb(${raw})` : `rgb(${raw} / ${alpha})`;
}
