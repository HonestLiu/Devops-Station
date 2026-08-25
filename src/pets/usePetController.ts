import { useEffect, useRef } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { type OpenPetsReaction } from "./petTypes";
import { useAppStore } from "@/store/useAppStore";

const PET_LABEL = "pet";

/**
 * The pet overlay window controls its own visibility (show/hide/focus on
 * itself). The main window only emits commands as events, which keeps all
 * window-manipulation permissions scoped to the "pet" window's capability set.
 */
export async function openPetWindow(scale: number, petId: string): Promise<void> {
  emitTo(PET_LABEL, "pet:set-pet", { id: petId }).catch(() => undefined);
  emitTo(PET_LABEL, "pet:scale", { scale }).catch(() => undefined);
  emitTo(PET_LABEL, "pet:open", {}).catch(() => undefined);
}

export async function hidePetWindow(): Promise<void> {
  emitTo(PET_LABEL, "pet:close", {}).catch(() => undefined);
}

export function petReact(reaction: OpenPetsReaction): void {
  void emitTo(PET_LABEL, "pet:react", { reaction }).catch(() => undefined);
}

export function petSay(text: string): void {
  void emitTo(PET_LABEL, "pet:say", { text }).catch(() => undefined);
}

export function petReset(): void {
  void emitTo(PET_LABEL, "pet:reset", {}).catch(() => undefined);
}

/** Show the approval-reminder dialog on the pet (e.g. "AI is waiting for your
 *  approval"). `sessionId` is the local terminal session the pending request is
 *  linked to, so the pet's Approve/Reject buttons can act on it. Stays until
 *  `petAlertClear` is emitted or the user dismisses it. */
export function petAlert(text: string, sessionId?: string): void {
  void emitTo(PET_LABEL, "pet:alert", { text, sessionId }).catch(() => undefined);
}

/** Clear the pet's reminder bubble. */
export function petAlertClear(): void {
  void emitTo(PET_LABEL, "pet:alert-clear", {}).catch(() => undefined);
}

/** Single global listener: when the pet window mounts it asks for state. */
function ensureReadyListener(): void {
  void listen<Record<string, never>>("pet:ready", () => {
    const { pet } = useAppStore.getState().settings;
    // The pet window just mounted and attached its listeners: push current
    // state, and reveal it if the user had it enabled in a previous session.
    emitTo(PET_LABEL, "pet:set-pet", { id: pet.petId }).catch(() => undefined);
    emitTo(PET_LABEL, "pet:scale", { scale: pet.scale }).catch(() => undefined);
    emitTo(PET_LABEL, "pet:stay", { stay: pet.stayPut }).catch(() => undefined);
    if (pet.enabled) {
      emitTo(PET_LABEL, "pet:open", {}).catch(() => undefined);
    }
  }).catch(() => undefined);
}

export interface PetController {
  open: () => Promise<void>;
  hide: () => Promise<void>;
  setPet: (id: string) => void;
  setScale: (scale: number) => void;
  setStayPut: (stay: boolean) => void;
  react: (r: OpenPetsReaction) => void;
  say: (text: string) => void;
  reset: () => void;
  alert: (text: string, sessionId?: string) => void;
  alertClear: () => void;
}

/** Hook used by the main window to drive the pet overlay. */
export function usePetController(): PetController {
  const updateSetting = useAppStore((s) => s.updateSetting);
  const initialized = useRef(false);

  useEffect(() => {
    ensureReadyListener();
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    // If the pet was enabled in a previous session, reveal it. The pet window
    // also asks for state on mount via "pet:ready", but that handshake can race
    // the main window's listener, so re-emit open shortly after to be safe.
    const { pet } = useAppStore.getState().settings;
    if (pet.enabled) {
      void openPetWindow(pet.scale, pet.petId);
      const t = setTimeout(() => {
        void openPetWindow(pet.scale, pet.petId);
      }, 800);
      return () => clearTimeout(t);
    }
  }, []);

  return {
    open: async () => {
      const { pet } = useAppStore.getState().settings;
      await updateSetting("pet", { ...pet, enabled: true });
      await openPetWindow(pet.scale, pet.petId);
    },
    hide: async () => {
      const { pet } = useAppStore.getState().settings;
      await updateSetting("pet", { ...pet, enabled: false });
      await hidePetWindow();
    },
    setPet: (id: string) => {
      const { pet } = useAppStore.getState().settings;
      void updateSetting("pet", { ...pet, petId: id });
      void emitTo(PET_LABEL, "pet:set-pet", { id }).catch(() => undefined);
    },
    setScale: (scale: number) => {
      const { pet } = useAppStore.getState().settings;
      void updateSetting("pet", { ...pet, scale });
      void emitTo(PET_LABEL, "pet:scale", { scale }).catch(() => undefined);
    },
    setStayPut: (stay: boolean) => {
      const { pet } = useAppStore.getState().settings;
      void updateSetting("pet", { ...pet, stayPut: stay });
      void emitTo(PET_LABEL, "pet:stay", { stay }).catch(() => undefined);
    },
    react: petReact,
    say: petSay,
    reset: petReset,
    alert: petAlert,
    alertClear: petAlertClear,
  };
}
