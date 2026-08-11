/**
 * One interface over the two byte-stream transports the Serial workspace can
 * drive: a wired serial port and a BLE GATT serial bridge.
 *
 * Both backends emit the same `StreamChunk` / `SessionClosed` payloads and both
 * implement the pre-attach backlog handshake, so everything downstream — the
 * record view, the plotter, the send composer — is transport-agnostic and only
 * this module knows which `invoke` to call.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";

import { ble, serial } from "@/lib/api";
import type { Attached, SessionClosed, StreamChunk } from "@/lib/types";

export type LinkKind = "serial" | "ble";

export interface DataLink {
  write(sessionId: string, data: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  attach(sessionId: string): Promise<Attached>;
  onData(sessionId: string, cb: (chunk: StreamChunk) => void): Promise<UnlistenFn>;
  onClosed(sessionId: string, cb: (info: SessionClosed) => void): Promise<UnlistenFn>;
}

export function dataLink(kind: LinkKind): DataLink {
  return kind === "ble" ? ble : serial;
}
