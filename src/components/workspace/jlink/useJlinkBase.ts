import { useEffect, useState } from "react";

import { useAppStore } from "@/store/useAppStore";
import { useJlinkStore } from "@/store/useJlinkStore";
import type { JLinkConfig } from "@/lib/types";
import { blockFor } from "./shared";

export interface JlinkBase {
  config: JLinkConfig;
  setConfig: (config: JLinkConfig) => void;
  /** null while probing the SEGGER install, then true/false. */
  available: boolean | null;
  devices: string[];
  busy: boolean;
  jlinkPath?: string;
  /**
   * Run one J-Link operation under the global `busy` lock, formatting the
   * result (`[time] title — OK/FAILED` + body) and handing it to `append` for
   * whatever console the caller owns.
   */
  runOp: (
    title: string,
    fn: () => Promise<{ success: boolean; output: string }>,
    append: (block: string) => void,
  ) => Promise<void>;
}

/**
 * Shared J-Link state for every module workspace: the probe config, driver
 * device list and availability all live in `useJlinkStore` so Flash / RTT / GDB
 * tabs stay in sync; `busy` + `runOp` give the one-operation-at-a-time guard.
 */
export function useJlinkBase(): JlinkBase {
  const jlinkPath = useAppStore((s) => s.settings.jlinkPath);
  const config = useJlinkStore((s) => s.config);
  const setConfig = useJlinkStore((s) => s.setConfig);
  const available = useJlinkStore((s) => s.available);
  const devices = useJlinkStore((s) => s.devices);
  const load = useJlinkStore((s) => s.load);
  const [busy, setBusy] = useState(false);

  // The store is probed once per path change; the picker page already triggers
  // it, but (re)load here too so a workspace opened directly (e.g. via a tab
  // surviving a Settings edit) always has fresh data.
  useEffect(() => {
    load(jlinkPath);
  }, [jlinkPath, load]);

  async function runOp(
    title: string,
    fn: () => Promise<{ success: boolean; output: string }>,
    append: (block: string) => void,
  ) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fn();
      append(blockFor(title, res.output || "(no output)", res.success));
    } catch (err) {
      append(blockFor(title, String(err), false));
    } finally {
      setBusy(false);
    }
  }

  return { config, setConfig, available, devices, busy, jlinkPath, runOp };
}
