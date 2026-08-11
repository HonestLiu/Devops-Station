/**
 * Serial codec helpers — parity-ported from SerialAssistant
 * (C:\Users\Hones\Develop\SerialAssistant).
 *
 * The original project uses the Web Serial API + Web Bluetooth API in the
 * browser; our devops-station drives the port from a Rust backend over Tauri, so
 * the *transport* can't be reused. What *is* reusable is the data layer: how a
 * typed string becomes the exact bytes on the wire, the checksum algorithms, and
 * the HEX normalizer. That logic lives here as pure, framework-free functions so
 * both the SendBar preview and the workspace send path share one implementation.
 */

import { hexToBytes, unescapeSequences } from "./utils";

export type SendFormat = "text" | "hex" | "dec";

export type ChecksumAlgo = "none" | "sum" | "parity" | "xor" | "modbus";

export interface ChecksumDef {
  id: ChecksumAlgo;
  label: string;
  /** Returns the trailing bytes to append (1 byte for sum/parity/xor, 2 for modbus). */
  compute: (data: Uint8Array) => Uint8Array;
}

export const CHECKSUM_ALGOS: ChecksumDef[] = [
  {
    id: "sum",
    label: "校验和",
    compute: (data) => Uint8Array.from([data.reduce((a, b) => a + b, 0) & 0xff]),
  },
  {
    id: "parity",
    label: "奇偶校验",
    compute: (data) => Uint8Array.from([data.reduce((a, b) => a + b, 0) % 2]),
  },
  {
    id: "xor",
    label: "异或校验",
    compute: (data) => Uint8Array.from([data.reduce((a, b) => a ^ b, 0)]),
  },
  {
    id: "modbus",
    label: "ModbusCRC16",
    compute: (data) => {
      let crc = 0xffff;
      for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
          if (crc & 0x01) {
            crc >>= 1;
            crc ^= 0xa001;
          } else {
            crc >>= 1;
          }
        }
      }
      return Uint8Array.from([crc & 0xff, crc >> 8]);
    },
  },
];

export function checksumLabel(id: ChecksumAlgo): string {
  if (id === "none") return "无校验";
  return CHECKSUM_ALGOS.find((c) => c.id === id)?.label ?? "无校验";
}

export function computeChecksum(id: ChecksumAlgo, data: Uint8Array): Uint8Array | null {
  if (id === "none") return null;
  return CHECKSUM_ALGOS.find((c) => c.id === id)?.compute(data) ?? null;
}

/**
 * Convert a whitespace/comma/0x separated decimal string into bytes.
 * Each token is parsed as an unsigned integer and emitted as its minimal
 * big-endian byte sequence (at least one byte), e.g. "255 256" -> [0xFF,01,00].
 * Returns null when any token is not a non-negative integer.
 */
export function decToBuffer(input: string): Uint8Array | null {
  const tokens = input
    .replace(/0x/gi, "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const out: number[] = [];
  for (const tok of tokens) {
    if (!/^\d+$/.test(tok)) return null;
    const n = Number(tok);
    if (!Number.isSafeInteger(n) || n < 0) return null;
    let hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    for (const byte of hexToBytes(hex)) out.push(byte);
  }
  return Uint8Array.from(out);
}

/**
 * Normalize a HEX string: strip spaces/0x/commas, pad a trailing odd nibble with
 * a leading 0, then re-group into pairs separated by single spaces — e.g.
 * "aab c" -> "AA 0B 0C". Mirrors SerialAssistant's reformatHex.
 */
export function reformatHex(input: string): string {
  const cleaned = input.replace(/0x/gi, "").replace(/[\s,]/g, "").toUpperCase();
  if (!cleaned) return "";
  const pairs = cleaned.match(/.{1,2}/g) ?? [];
  const fixed = pairs.map((p) => (p.length === 1 ? "0" + p : p));
  return fixed.join(" ");
}

export interface SendMeta {
  format: SendFormat;
  raw: string;
  checksum: ChecksumAlgo;
}

export interface EncodeOptions {
  raw: string;
  format: SendFormat;
  /** Actual line-ending string already resolved (e.g. "\n", "\r\n", or ""). */
  lineEnding: string;
  checksum: ChecksumAlgo;
}

export interface EncodeResult {
  bytes?: Uint8Array;
  /** Trailing checksum bytes (only present in HEX mode with a non-"none" algo). */
  checksumBytes?: Uint8Array;
  error?: string;
  warning?: string;
}

/**
 * The single source of truth that turns the composer field into wire bytes.
 * - text:  escaped text + line ending (UTF-8)
 * - hex:   hexToBytes(raw); checksum appended only here
 * - dec:   space/comma separated unsigned decimals -> bytes
 */
export function encodeSendData(opts: EncodeOptions): EncodeResult {
  const { raw, format, lineEnding, checksum } = opts;
  if (!raw.trim()) return { error: "空内容" };

  if (format === "text") {
    const text = unescapeSequences(raw) + lineEnding;
    return { bytes: new TextEncoder().encode(text) };
  }

  if (format === "hex") {
    const cleaned = raw.replace(/0x/gi, "").replace(/[\s,]/g, "");
    if (!cleaned) return { error: "无十六进制数字" };
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
      return { error: "包含非十六进制字符" };
    }
    const bytes = hexToBytes(raw);
    const odd = cleaned.length % 2 === 1;
    const warning = odd ? "奇数位十六进制 — 末位已补 0" : undefined;
    const checksumBytes = computeChecksum(checksum, bytes);
    const out =
      checksumBytes && checksumBytes.length
        ? Uint8Array.from([...bytes, ...checksumBytes])
        : bytes;
    return { bytes: out, checksumBytes: checksumBytes ?? undefined, warning };
  }

  // dec
  const bytes = decToBuffer(raw);
  if (!bytes) return { error: "包含非法的十进制数字" };
  return { bytes };
}
