/** Fallback device list shown before the driver's device database loads. */
export const DEVICE_PRESETS = [
  "STM32F103C8",
  "STM32F407VG",
  "STM32L4",
  "STM32H7",
  "nRF52840_xxAA",
  "nRF5340_xxAA",
  "GD32F303",
  "ATSAMD21G18",
  "RP2040",
  "MIMXRT1052",
  "LPC1768",
];

export const SPEEDS = [0, 100, 400, 1000, 2000, 4000, 8000];

export const inputCls =
  "h-9 w-full rounded-lg border border-border bg-bg px-2.5 text-[13px] text-fg outline-none focus:border-accent";

/** Format one labelled result block for an output console. */
export function blockFor(title: string, body: string, ok: boolean): string {
  const stamp = new Date().toLocaleTimeString();
  const head = `[${stamp}] ${title} — ${ok ? "OK" : "FAILED"}`;
  return `${head}\n${body.trim()}\n`;
}
