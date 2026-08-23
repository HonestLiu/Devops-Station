import { create } from "zustand";

import { jlink } from "@/lib/api";
import type { JLinkConfig } from "@/lib/types";
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
}

export const useJlinkStore = create<JlinkState>((set) => ({
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
}));
