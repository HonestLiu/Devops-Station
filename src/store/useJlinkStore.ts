import { create } from "zustand";

import { jlink } from "@/lib/api";
import type { JLinkConfig, JLinkStatus } from "@/lib/types";
import { DEVICE_PRESETS } from "@/components/workspace/jlink/shared";

interface JlinkState {
  /**
   * Shared probe config (device/iface/speed) used by every J-Link module tab.
   * Kept in one store so configuring the device once applies to Flash / RTT /
   * GDB alike — the old single-page behavior, preserved across the tabs.
   */
  config: JLinkConfig;
  setConfig: (config: JLinkConfig) => void;
  /** null while probing the SEGGER install, then true/false. */
  available: boolean | null;
  /** Driver device database (seeded with a curated fallback list). */
  devices: string[];
  /** (Re)probe the J-Link software + driver device list. */
  load: (exePath?: string) => void;
  /**
   * Last successful connect, mirrored from the backend. Empty object (no
   * `device`) means "not connected" — see `isConnected` for the boolean form.
   * The probe itself is one-shot per script, so this is purely a UI snapshot.
   */
  status: JLinkStatus;
  /** Replace the status with what the backend reports. */
  setStatus: (status: JLinkStatus) => void;
  /** Forget the cached status. Used by the workspace Disconnect button. */
  clearStatus: () => void;
  /** Re-fetch the status from the backend (e.g. on workspace mount). */
  refreshStatus: () => void;
  /** Convenience: did the user successfully connect at least once? */
  isConnected: () => boolean;
}

export const useJlinkStore = create<JlinkState>((set, get) => ({
  config: { device: "STM32F103C8", iface: "SWD", speed: 4000 },
  setConfig: (config) => set({ config }),
  available: null,
  devices: DEVICE_PRESETS,
  load: (exePath) => {
    jlink
      .available(exePath)
      .then((v) => set({ available: v }))
      .catch(() => set({ available: false }));
    jlink
      .devices(exePath)
      .then((list) => {
        if (list.length) set({ devices: list });
      })
      .catch(() => {});
  },
  status: { device: "", iface: "", speed: 0, serial: undefined, connectedAt: 0 },
  setStatus: (status) => set({ status }),
  clearStatus: () => set({ status: { device: "", iface: "", speed: 0, serial: undefined, connectedAt: 0 } }),
  refreshStatus: () => {
    jlink
      .status()
      .then((status) => set({ status }))
      .catch(() => undefined);
  },
  isConnected: () => get().status.device.trim().length > 0,
}));
