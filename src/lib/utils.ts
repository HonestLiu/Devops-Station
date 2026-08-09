import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- base64 <-> bytes ------------------------------------------------------
// The backend speaks base64 for every byte stream so binary data (and invalid
// UTF-8 from a half-booted board) survives the IPC boundary intact.

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

// --- hex helpers -----------------------------------------------------------

export function bytesToHex(bytes: Uint8Array, separator = " "): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(separator);
}

/** Parse loose hex input: "AA BB", "aabb", "0xAA,0xBB" all work. */
export function hexToBytes(input: string): Uint8Array {
  const cleaned = input
    .replace(/0x/gi, "")
    .replace(/[^0-9a-fA-F]/g, "");
  const pairs = cleaned.match(/.{1,2}/g) ?? [];
  return new Uint8Array(pairs.map((p) => parseInt(p.padEnd(2, "0"), 16)));
}

export function isValidHex(input: string): boolean {
  const cleaned = input.replace(/0x/gi, "").replace(/[\s,]/g, "");
  return cleaned.length > 0 && /^[0-9a-fA-F]+$/.test(cleaned);
}

/** Render bytes as printable ASCII, replacing control bytes with `.`. */
export function bytesToAscii(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
    .join("");
}

export function bytesToBinary(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(2).padStart(8, "0"))
    .join(" ");
}

export function bytesToDecimal(bytes: Uint8Array): string {
  return Array.from(bytes).join(" ");
}

/**
 * Interpret escape sequences the way a serial terminal user expects:
 * `\r` `\n` `\t` `\0` `\xNN` and `\\`.
 */
export function unescapeSequences(input: string): string {
  return input.replace(/\\(x[0-9a-fA-F]{2}|[rnt0\\])/g, (_, code: string) => {
    switch (code) {
      case "r":
        return "\r";
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      default:
        return String.fromCharCode(parseInt(code.slice(1), 16));
    }
  });
}

export const LINE_ENDINGS: Record<string, string> = {
  none: "",
  cr: "\r",
  lf: "\n",
  crlf: "\r\n",
};

// --- formatting ------------------------------------------------------------

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

export function formatKb(kb: number, decimals = 1): string {
  return formatBytes(kb * 1024, decimals);
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec, 1)}/s`;
}

export function formatUptime(seconds: number): string {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((v) => String(v).padStart(2, "0"))
    .join(":");
}

export function formatMtime(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const pad = (v: number) => String(v).padStart(2, "0");
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return sameYear
    ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    : `${d.getFullYear()}-${date}`;
}

/** Render Unix mode bits as `drwxr-xr-x`. */
export function formatPermissions(mode: number, isDir: boolean): string {
  const rwx = (bits: number) =>
    `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  return `${isDir ? "d" : "-"}${rwx((mode >> 6) & 7)}${rwx((mode >> 3) & 7)}${rwx(mode & 7)}`;
}

// --- ssh command parsing ---------------------------------------------------

export interface ParsedSsh {
  username: string;
  hostname: string;
  port: number;
  valid: boolean;
}

/**
 * Parse the quick-connect bar. Accepts everything a person would plausibly
 * paste in:
 *   ssh root@10.0.0.1
 *   ssh -p 2222 root@box.local
 *   root@10.0.0.1:2222
 *   10.0.0.1
 */
export function parseSshCommand(input: string): ParsedSsh {
  const empty: ParsedSsh = { username: "", hostname: "", port: 22, valid: false };
  let text = input.trim();
  if (!text) return empty;

  text = text.replace(/^ssh\s+/i, "");

  let port = 22;
  // -p 2222 / -p2222
  const portFlag = text.match(/(?:^|\s)-p\s*(\d{1,5})(?:\s|$)/);
  if (portFlag) {
    port = Number(portFlag[1]);
    text = text.replace(portFlag[0], " ").trim();
  }

  // Drop any remaining flags with their values (-i key, -o Opt=val, ...).
  text = text
    .split(/\s+/)
    .filter((token, i, all) => {
      if (token.startsWith("-")) return false;
      const prev = all[i - 1];
      return !(prev && prev.startsWith("-") && prev.length === 2);
    })
    .join(" ")
    .trim();

  const target = text.split(/\s+/)[0] ?? "";
  if (!target) return empty;

  let username = "";
  let hostPart = target;
  const at = target.lastIndexOf("@");
  if (at >= 0) {
    username = target.slice(0, at);
    hostPart = target.slice(at + 1);
  }

  // host:port — but leave bare IPv6 alone.
  const colonCount = (hostPart.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const [h, p] = hostPart.split(":");
    if (/^\d{1,5}$/.test(p)) {
      hostPart = h;
      port = Number(p);
    }
  }

  const hostname = hostPart.replace(/^\[|\]$/g, "");
  const valid = hostname.length > 0 && port > 0 && port <= 65535;
  return { username, hostname, port, valid };
}

/** Deterministic accent colour for a host card, derived from its name. */
export function hashColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  const palette = [
    "#7aa2f7", "#9ece6a", "#e0af68", "#f7768e",
    "#bb9af7", "#7dcfff", "#ff9e64", "#41a6b5",
  ];
  return palette[Math.abs(hash) % palette.length];
}

export function shortPath(path: string, maxSegments = 3): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= maxSegments) return path;
  return `…/${parts.slice(-maxSegments).join("/")}`;
}

export function parentPath(path: string): string {
  if (path === "/" || !path) return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}
