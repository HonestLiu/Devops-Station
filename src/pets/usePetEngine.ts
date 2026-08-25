import { useEffect, useRef } from "react";
import { getCurrentWindow, currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import type { PetDef } from "./petManifest";
import {
  PET_LAYOUT,
  REACTION_TO_STATE,
  WALK_LEFT,
  WALK_RIGHT,
  TRANSIENT_REACTIONS,
  type OpenPetsReaction,
  type SpriteState,
} from "./petTypes";

interface UsePetEngineOpts {
  scale: number;
  pets: PetDef[];
  petId: string;
  /** When true the pet stays at a fixed position instead of wandering. */
  stayPut: boolean;
  /** Suspend the loop (e.g. while the chat dialog is open). */
  paused?: boolean;
  onState: (s: SpriteState) => void;
  onBubble: (text: string | null) => void;
}

export interface PetEngineHandle {
  react: (r: OpenPetsReaction) => void;
  say: (text: string, ms?: number) => void;
  reset: () => void;
  greet: () => void;
}

const SPEED = 70; // logical px / second while walking
const PET_HEADROOM = 120; // reserved above the sprite for the speech bubble

export function usePetEngine(opts: UsePetEngineOpts) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const engineRef = useRef<PetEngineHandle>({
    react: () => {},
    say: () => {},
    reset: () => {},
    greet: () => {},
  });

  const dragHandlers = useRef<{
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onClick: (e: React.MouseEvent) => void;
  }>({
    onPointerDown: () => {},
    onPointerMove: () => {},
    onPointerUp: () => {},
    onClick: () => {},
  });

  useEffect(() => {
    let alive = true;
    let raf = 0;
    let dir: 1 | -1 = 1;
    let mode: "walk" | "idle" | "react" = "idle";
    let reactUntil = 0;
    let idleUntil = 0;
    /** Persistent reaction row shown while the pet keeps wandering. */
    let forcedState: SpriteState | null = null;
    let x = 200;
    let y = 200;
    let lastTick = performance.now();
    let lastMove = 0;
    let bubbleTimer: number | undefined;
    let currentKey = "";

    // Drag state
    let dragging = false;
    let pressed = false;
    let moved = 0;
    let downClient = { x: 0, y: 0 };
    let downTime = 0;
    let lastMovedAt = 0; // timestamp of the last real window move (from onMoved)
    let dpr = 1; // logical→physical scale, for reading back window position
    let moveUnlisten: (() => void) | null = null;

    const setState = (s: SpriteState) => optsRef.current.onState(s);
    const setBubble = (t: string | null) => optsRef.current.onBubble(t);
    // Only push a new sprite state when the (row,frames) actually changes, so
    // the CSS animation isn't restarted every frame while wandering.
    const applyState = (s: SpriteState) => {
      const key = `${s.row}-${s.frames}`;
      if (key === currentKey) return;
      currentKey = key;
      setState(s);
    };

    interface Bounds { x: number; y: number; w: number; h: number; }
    let bounds: Bounds = { x: 0, y: 0, w: 1920, h: 1080 };

    async function refreshBounds() {
      try {
        const m = (await currentMonitor()) ?? (await primaryMonitor());
        if (m) {
          // Monitor geometry is physical; divide by the scale factor to get the
          // logical coordinates the webview/CSS actually use.
          const dpr = m.scaleFactor || 1;
          bounds = {
            x: m.position.x / dpr,
            y: m.position.y / dpr,
            w: m.size.width / dpr,
            h: m.size.height / dpr,
          };
          return;
        }
      } catch {
        /* fall through */
      }
      bounds = { x: 0, y: 0, w: window.screen.availWidth, h: window.screen.availHeight };
    }

    function frameW() {
      return PET_LAYOUT.frameWidth * optsRef.current.scale;
    }
    function frameH() {
      return PET_LAYOUT.frameHeight * optsRef.current.scale;
    }

    async function placeAtBottomCenter() {
      await refreshBounds();
      const w = frameW();
      const h = frameH();
      const total = h + PET_HEADROOM;
      x = bounds.x + Math.max(10, (bounds.w - w) / 2);
      y = bounds.y + bounds.h - total - 40;
      try {
        await getCurrentWindow().setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
      } catch {
        /* ignore */
      }
    }

    function loop() {
      if (!alive) return;
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (dragging) {
        // OS is driving the window move. The browser often stops delivering
        // pointerup once an OS drag starts, so we can't rely on it to clear
        // `dragging`. Instead, clear it shortly after real moves stop arriving.
        if (now - lastMovedAt > 150) dragging = false;
        // Keep dt small so wandering doesn't lurch on resume.
        lastTick = now;
        return;
      }
      if (optsRef.current.paused) {
        lastTick = now;
        return;
      }
      if (now - lastMove < 16) return;
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      lastMove = now;

      // Transient reaction: hold the pose in place until it finishes.
      if (mode === "react") {
        if (now >= reactUntil) {
          mode = forcedState ? "walk" : "idle";
          idleUntil = 0;
          applyState(forcedState ?? REACTION_TO_STATE.idle);
        } else {
          return;
        }
      }

      // Fixed-position mode: show idle (or a persistent reaction row) in place
      // and never wander. The user can still drag the pet to reposition it.
      if (optsRef.current.stayPut) {
        applyState(forcedState ?? REACTION_TO_STATE.idle);
        return;
      }

      if (mode === "idle") {
        if (now < idleUntil) return;
        mode = "walk";
        dir = Math.random() < 0.5 ? 1 : -1;
      }

      // Choose the sprite row for this tick. A persistent reaction overrides the
      // walk rows but the pet still wanders horizontally.
      const desired = forcedState ?? (dir === 1 ? WALK_RIGHT : WALK_LEFT);
      applyState(desired);

      const w = frameW();
      let nx = x + SPEED * dt * dir;
      const maxX = bounds.x + bounds.w - w - 10;
      const minX = bounds.x + 10;
      if (nx >= maxX) {
        nx = maxX;
        dir = -1;
        if (!forcedState) applyState(WALK_LEFT);
      } else if (nx <= minX) {
        nx = minX;
        dir = 1;
        if (!forcedState) applyState(WALK_RIGHT);
      }
      x = nx;

      // Occasionally pause to idle (only when no persistent reaction is active).
      if (!forcedState && Math.random() < 0.004) {
        mode = "idle";
        idleUntil = now + 1500 + Math.random() * 3500;
        applyState(REACTION_TO_STATE.idle);
      }

      try {
        void getCurrentWindow().setPosition(new LogicalPosition(Math.round(x), Math.round(y)));
      } catch {
        /* ignore */
      }
    }

    function playReaction(r: OpenPetsReaction) {
      const st = REACTION_TO_STATE[r];
      if (r === "idle") {
        // Resume normal wandering.
        forcedState = null;
        mode = "idle";
        idleUntil = 0;
        applyState(REACTION_TO_STATE.idle);
        return;
      }
      if (TRANSIENT_REACTIONS.has(r)) {
        // Hold the pose briefly, then fall back to the persistent/idle state.
        forcedState = null;
        mode = "react";
        const iters = typeof st.iterations === "number" ? st.iterations : 1;
        reactUntil = performance.now() + st.durationMs * iters + 350;
        applyState(st);
      } else {
        // Persistent reaction: keep wandering while showing this animation row.
        forcedState = st;
        mode = "walk";
        idleUntil = 0;
        applyState(st);
      }
    }

    function say(text: string, ms = 2600) {
      setBubble(text);
      if (bubbleTimer) window.clearTimeout(bubbleTimer);
      bubbleTimer = window.setTimeout(() => setBubble(null), ms);
    }

    // Keep the engine's x/y in sync with the real window position. This covers
    // both our own setPosition() calls and OS-driven drags (startDragging()),
    // so wandering always resumes from where the window actually is — no jump.
    void getCurrentWindow()
      .scaleFactor()
      .then((sf) => {
        dpr = sf || 1;
      })
      .catch(() => {
        dpr = 1;
      });

    void getCurrentWindow()
      .onMoved((e) => {
        x = e.payload.x / dpr;
        y = e.payload.y / dpr;
        lastMovedAt = performance.now();
      })
      .then((unlisten) => {
        moveUnlisten = unlisten;
      })
      .catch(() => {
        moveUnlisten = null;
      });

    // Wire the imperative handle.
    const greet = () => {
      playReaction("waving");
      const phrases = [
        "Hello! 👋",
        "Need a hand?",
        "I'm watching your agents.",
        "Boop!",
        "Stay focused! 💪",
        "Let's ship it.",
      ];
      say(phrases[Math.floor(Math.random() * phrases.length)]);
    };
    engineRef.current = { react: playReaction, say, reset: placeAtBottomCenter, greet };

    // Drag handlers. We only hand the move to the OS (startDragging) once the
    // pointer actually travels past a threshold — a plain click never starts an
    // OS drag, so its click event survives and the greet bubble fires. The OS
    // drag repaints the transparent window cleanly (no ghosting).
    dragHandlers.current = {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        pressed = true;
        moved = 0;
        downClient = { x: e.clientX, y: e.clientY };
        downTime = performance.now();
        dragging = false;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!pressed) return;
        moved = Math.max(moved, Math.abs(e.clientX - downClient.x) + Math.abs(e.clientY - downClient.y));
        if (!dragging && moved > 4) {
          dragging = true;
          lastMovedAt = performance.now();
          // Promote to an OS-driven drag for smooth, ghost-free movement.
          void getCurrentWindow().startDragging().catch(() => undefined);
        }
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (!pressed) return;
        pressed = false;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
        if (dragging) {
          dragging = false;
        } else if (moved < 4 && performance.now() - downTime < 350) {
          // Treated as a click: greet with a speech bubble.
          greet();
        }
      },
      onClick: () => {
        /* greet handled in onPointerUp to avoid double-firing */
      },
    };

    void placeAtBottomCenter().then(() => {
      applyState(REACTION_TO_STATE.idle);
      loop();
    });

    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      if (bubbleTimer) window.clearTimeout(bubbleTimer);
      if (moveUnlisten) moveUnlisten();
    };
    // Engine runs once for the lifetime of the pet window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { engineRef, dragHandlers };
}
