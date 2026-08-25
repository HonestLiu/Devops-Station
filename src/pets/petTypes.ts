// Pet sprite/reaction model — adapted from openpets' Plugin SDK v3
// reaction-animation-mapping (V1 spritesheet layout).
//
// The default openpets pet sprite sheet is 1536x1872 = 8 columns x 9 rows,
// each frame 192x208. Each row is one animation; the table below maps a
// reaction (or walk direction) to its row + frame count + timing.

export type OpenPetsReaction =
  | "idle"
  | "thinking"
  | "working"
  | "editing"
  | "running"
  | "testing"
  | "waiting"
  | "waving"
  | "success"
  | "celebrating"
  | "error";

export interface SpriteState {
  /** Row index in the spritesheet. */
  row: number;
  /** Number of frames used in that row. */
  frames: number;
  /** Duration of one full pass, in ms. */
  durationMs: number;
  /** Repetitions; "infinite" loops until state changes. */
  iterations: number | "infinite";
}

/** Default (built-in) openpets pet sheet layout (V1). */
export const PET_LAYOUT = {
  frameWidth: 192,
  frameHeight: 208,
  columns: 8,
  rows: 9,
} as const;

/** Reactions driven by the host (AI status / manual triggers). */
export const REACTION_TO_STATE: Record<OpenPetsReaction, SpriteState> = {
  idle: { row: 0, frames: 6, durationMs: 5500, iterations: "infinite" },
  thinking: { row: 8, frames: 6, durationMs: 1030, iterations: "infinite" }, // review
  working: { row: 7, frames: 6, durationMs: 820, iterations: "infinite" },
  editing: { row: 7, frames: 6, durationMs: 820, iterations: "infinite" },
  running: { row: 7, frames: 6, durationMs: 820, iterations: "infinite" },
  testing: { row: 7, frames: 6, durationMs: 820, iterations: "infinite" },
  waiting: { row: 6, frames: 6, durationMs: 1600, iterations: "infinite" },
  waving: { row: 3, frames: 4, durationMs: 700, iterations: 2 },
  success: { row: 4, frames: 5, durationMs: 840, iterations: 2 },
  celebrating: { row: 4, frames: 5, durationMs: 840, iterations: "infinite" },
  error: { row: 5, frames: 8, durationMs: 1220, iterations: 2 },
};

/** Non-reaction walk states, chosen by the wandering engine. */
export const WALK_RIGHT: SpriteState = { row: 1, frames: 8, durationMs: 1060, iterations: "infinite" };
export const WALK_LEFT: SpriteState = { row: 2, frames: 8, durationMs: 1060, iterations: "infinite" };

/** Reactions that play once (or a few times) then return to idle. */
export const TRANSIENT_REACTIONS: ReadonlySet<OpenPetsReaction> = new Set<OpenPetsReaction>([
  "success",
  "celebrating",
  "error",
  "waving",
]);

export const CLICK_PHRASES = [
  "Hello! 👋",
  "Need a hand?",
  "I'm watching your agents.",
  "Boop!",
  "Stay focused! 💪",
  "Let's ship it.",
];
