import { useEffect, useState } from "react";
import { Cat, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/i18n";
import { useAppStore } from "@/store/useAppStore";
import { loadPetManifest, type PetDef } from "@/pets/petManifest";
import { usePetController } from "@/pets/usePetController";
import type { OpenPetsReaction } from "@/pets/petTypes";

const MANUAL_REACTIONS: { id: OpenPetsReaction; label: string }[] = [
  { id: "thinking", label: "🤔 Think" },
  { id: "editing", label: "✏️ Edit" },
  { id: "running", label: "🏃 Run" },
  { id: "waiting", label: "⏳ Wait" },
  { id: "success", label: "🎉 Success" },
  { id: "error", label: "💥 Error" },
  { id: "waving", label: "👋 Wave" },
];

/** Phrases the pet can say when you trigger the "pop dialog" action. */
const SAY_PHRASES = [
  "你好呀！👋",
  "我在盯着你的智能体呢。",
  "需要帮忙吗？",
  "Boop! 🐾",
  "保持专注！💪",
  "一起把它搞定吧。",
  "Hello! 👋",
  "Need a hand?",
  "I'm watching your agents.",
];

export function PetsPanel() {
  const t = useT();
  const open = useAppStore((s) => s.petPanelOpen);
  const setOpen = useAppStore((s) => s.setPetPanelOpen);
  const pet = useAppStore((s) => s.settings.pet);
  const petEnabled = pet.enabled;
  const ctrl = usePetController();

  const [pets, setPets] = useState<PetDef[]>([]);
  useEffect(() => {
    void loadPetManifest().then((m) => setPets(m.pets));
  }, []);

  // Close on Escape, like the command palette.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open || !petEnabled) return null;

  const toggleEnabled = () => {
    if (pet.enabled) void ctrl.hide();
    else void ctrl.open();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh]">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={() => setOpen(false)}
      />
      <div className="relative w-full max-w-md animate-scale-in overflow-hidden rounded-lg border border-border bg-elevated shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
          <Cat size={16} className="text-accent" />
          <span className="text-[13px] font-semibold text-fg">{t("nav.pets")}</span>
          <button
            onClick={() => setOpen(false)}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-3 py-3">
          {/* Enable */}
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-[12px] text-fg">{t("pets.enabled")}</span>
            <input
              type="checkbox"
              checked={pet.enabled}
              onChange={toggleEnabled}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>

          {/* Gallery */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
              {t("pets.gallery")}
            </p>
            <div className="grid grid-cols-3 gap-2">
              {pets.map((p) => (
                <button
                  key={p.id}
                  onClick={() => ctrl.setPet(p.id)}
                  disabled={!pet.enabled}
                  title={p.name}
                  className={cn(
                    "flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-bg/40 p-1 transition-colors",
                    pet.petId === p.id
                      ? "border-accent ring-1 ring-accent/40"
                      : "border-border/60 hover:border-border",
                    !pet.enabled && "opacity-50",
                  )}
                >
                  <img
                    src={p.thumbnail}
                    alt={p.name}
                    className="max-h-full max-w-full object-contain"
                    style={{ filter: p.tint ?? undefined }}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Scale */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[12px] text-fg">{t("pets.size")}</span>
              <span className="font-mono text-[11px] text-subtle">
                {Math.round(pet.scale * 100)}%
              </span>
            </div>
            <input
              type="range"
              min={0.5}
              max={2.5}
              step={0.1}
              value={pet.scale}
              disabled={!pet.enabled}
              onChange={(e) => ctrl.setScale(parseFloat(e.target.value))}
              className="w-full accent-[var(--accent)]"
            />
          </div>

          {/* React to AI */}
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-[12px] text-fg">{t("pets.reactToAi")}</span>
            <input
              type="checkbox"
              checked={pet.reactToAi}
              disabled={!pet.enabled}
              onChange={(e) =>
                void useAppStore.getState().updateSetting("pet", {
                  ...useAppStore.getState().settings.pet,
                  reactToAi: e.target.checked,
                })
              }
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>

          {/* Stay put (fixed position) */}
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-[12px] text-fg">{t("pets.stayPut")}</span>
            <input
              type="checkbox"
              checked={pet.stayPut}
              disabled={!pet.enabled}
              onChange={(e) => ctrl.setStayPut(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>

          {/* Manual reactions */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
              {t("pets.manual")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {MANUAL_REACTIONS.map((r) => (
                <button
                  key={r.id}
                  disabled={!pet.enabled}
                  onClick={() => ctrl.react(r.id)}
                  className="rounded-md border border-border/60 bg-bg/40 px-2 py-1 text-[11px] text-fg transition-colors hover:border-accent/50 hover:bg-hover disabled:opacity-50"
                >
                  {r.label}
                </button>
              ))}
              <button
                disabled={!pet.enabled}
                onClick={() =>
                  ctrl.say(SAY_PHRASES[Math.floor(Math.random() * SAY_PHRASES.length)])
                }
                className="rounded-md border border-accent/50 bg-accent/10 px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
              >
                💬 {t("pets.say")}
              </button>
            </div>
          </div>

          <button
            disabled={!pet.enabled}
            onClick={() => ctrl.reset()}
            className="rounded-md border border-border/60 bg-bg/40 px-2 py-1.5 text-[12px] text-fg transition-colors hover:border-accent/50 hover:bg-hover disabled:opacity-50"
          >
            {t("pets.reset")}
          </button>

          <p className="text-[10px] leading-relaxed text-subtle">
            {t("pets.credit")}
          </p>
        </div>
      </div>
    </div>
  );
}
