import { create } from "zustand";

/** A pending "trust this host?" prompt raised during SSH connect. */
interface HostKeyPrompt {
  host: string;
  port: number;
  fingerprint: string;
  /** true = the key changed since last time (possible MITM). */
  mismatch: boolean;
  resolve: (trust: boolean) => void;
}

interface HostKeyState {
  prompt: HostKeyPrompt | null;
  /** Show the prompt and resolve to the user's choice (true = trust). */
  request: (p: Omit<HostKeyPrompt, "resolve">) => Promise<boolean>;
  /** Called by the modal with the user's decision. */
  respond: (trust: boolean) => void;
}

export const useHostKeyStore = create<HostKeyState>((set, get) => ({
  prompt: null,
  request: (p) =>
    new Promise<boolean>((resolve) => {
      set({ prompt: { ...p, resolve } });
    }),
  respond: (trust) => {
    const p = get().prompt;
    if (p) {
      p.resolve(trust);
      set({ prompt: null });
    }
  },
}));
