import { type CSSProperties } from "react";
import type { PetDef } from "./petManifest";
import { PET_LAYOUT, type SpriteState } from "./petTypes";

interface PetSpriteProps {
  pet: PetDef;
  scale: number;
  state: SpriteState;
}

/**
 * Renders one frame-sized window into the spritesheet and animates it across
 * the active row using a steps() background-position animation.
 */
export function PetSprite({ pet, scale, state }: PetSpriteProps) {
  const fw = PET_LAYOUT.frameWidth * scale;
  const fh = PET_LAYOUT.frameHeight * scale;
  const fullW = PET_LAYOUT.frameWidth * PET_LAYOUT.columns * scale;
  const fullH = PET_LAYOUT.frameHeight * PET_LAYOUT.rows * scale;

  const style = {
    width: fw,
    height: fh,
    backgroundImage: `url(${pet.sprite})`,
    backgroundSize: `${fullW}px ${fullH}px`,
    backgroundPositionY: `-${state.row * fh}px`,
    // CSS custom props consumed by the @keyframes pet-step rule.
    ["--pet-fw"]: `${fw}px`,
    ["--pet-frames"]: state.frames,
    animationName: "pet-step",
    animationDuration: `${state.durationMs}ms`,
    animationTimingFunction: `steps(${state.frames})`,
    animationIterationCount: state.iterations === "infinite" ? "infinite" : state.iterations,
    animationFillMode: "both",
    filter: pet.tint ?? undefined,
  } as CSSProperties;

  // Remounting on state change restarts the animation cleanly.
  return <div key={`${state.row}-${state.frames}`} className="pet-sprite" style={style} />;
}
