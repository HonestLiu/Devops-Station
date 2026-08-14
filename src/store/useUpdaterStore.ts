import { create } from "zustand";
import type { Update } from "@tauri-apps/plugin-updater";

interface UpdaterState {
  /** True while a check (or the auto-check-on-startup) is in flight. */
  checking: boolean;
  /** The pending update, or null. */
  update: Update | null;
  /** Whether the update dialog is visible. */
  open: boolean;
  /** True while the update package is downloading + installing. */
  downloading: boolean;
  /** Bytes downloaded so far. */
  downloaded: number;
  /** Total bytes (0 when unknown). */
  total: number;
  /** null = no error. The sentinel "upToDate" means "checked, already latest". */
  error: string | null;
  setChecking: (v: boolean) => void;
  setUpdating: (u: Update | null) => void;
  setOpen: (v: boolean) => void;
  setDownloading: (v: boolean) => void;
  setProgress: (downloaded: number, total: number) => void;
  setError: (e: string | null) => void;
  reset: () => void;
}

/**
 * Drives the update dialog. Both the startup auto-check and the manual
 * "Check for updates" button funnel through `lib/updater.ts`, which writes
 * the result here; a single `UpdateDialog` reads from this store.
 */
export const useUpdaterStore = create<UpdaterState>((set) => ({
  checking: false,
  update: null,
  open: false,
  downloading: false,
  downloaded: 0,
  total: 0,
  error: null,
  setChecking: (v) => set({ checking: v }),
  setUpdating: (u) => set({ update: u }),
  setOpen: (v) => set({ open: v }),
  setDownloading: (v) => set({ downloading: v }),
  setProgress: (downloaded, total) => set({ downloaded, total }),
  setError: (e) => set({ error: e }),
  reset: () =>
    set({ open: false, downloading: false, downloaded: 0, total: 0, error: null, update: null }),
}));
