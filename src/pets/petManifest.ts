import { PET_LAYOUT, type OpenPetsReaction } from "./petTypes";

export interface PetDef {
  id: string;
  name: string;
  /** URL to the spritesheet (webp). */
  sprite: string;
  /** URL to a small preview thumbnail. */
  thumbnail: string;
  /** Optional CSS filter applied to recolor the sprite (e.g. hue-rotate). */
  tint: string | null;
  /** Optional per-pet scale multiplier (defaults to 1). */
  scaleOffset?: number;
}

export interface PetManifest {
  version: number;
  layout: typeof PET_LAYOUT;
  pets: PetDef[];
}

let cache: PetManifest | null = null;

/** Load the bundled pet catalog (public/pets/manifest.json). */
export async function loadPetManifest(): Promise<PetManifest> {
  if (cache) return cache;
  try {
    const res = await fetch("/pets/manifest.json");
    if (!res.ok) throw new Error(`pet manifest HTTP ${res.status}`);
    const data = (await res.json()) as PetManifest;
    cache = data;
    return data;
  } catch {
    // Fallback so the feature still works without the manifest.
    cache = {
      version: 1,
      layout: PET_LAYOUT,
      pets: [
        {
          id: "professor-hoot",
          name: "Professor Hoot",
          sprite: "/pets/default/spritesheet.webp",
          thumbnail: "/pets/default/thumbnail.png",
          tint: null,
        },
      ],
    };
    return cache;
  }
}

export function resolvePet(pets: PetDef[], id: string | null | undefined): PetDef {
  return pets.find((p) => p.id === id) ?? pets[0];
}

/** Map an AI-agent status (from perm-state-changed) to a pet reaction. */
export function agentStatusToReaction(statuses: string[]): OpenPetsReaction {
  if (statuses.includes("waitingapproval")) return "waiting";
  if (statuses.includes("working")) return "running";
  return "idle";
}
