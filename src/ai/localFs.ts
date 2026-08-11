import { localFs } from "@/lib/api";
import type { LocalEntry } from "@/lib/types";

export interface ScanOptions {
  /** Max directory depth to recurse (0 = just the root entries). */
  maxDepth?: number;
  /** Stop listing after this many total entries (safety cap). */
  maxEntries?: number;
  /** Cap entries listed per directory; extras are noted as truncated. */
  maxDirEntries?: number;
}

export interface ScanResult {
  /** Human-readable directory tree (indented, dirs suffixed with "/"). */
  tree: string;
  fileCount: number;
  dirCount: number;
  truncated: boolean;
  /** Files sorted by size descending (for "find large files"). */
  bySize: { path: string; size: number }[];
}

/**
 * Recursively list a local directory into a compact tree string, with hard caps
 * so a stray `node_modules` can never hang the UI. Reuses the existing
 * `localFs.list` command (the same one the dual-pane SFTP tab uses).
 */
export async function scanLocalDir(
  root: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxEntries = opts.maxEntries ?? 800;
  const maxDirEntries = opts.maxDirEntries ?? 80;

  const lines: string[] = [];
  const bySize: { path: string; size: number }[] = [];
  const visited = new Set<string>();
  let fileCount = 0;
  let dirCount = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || lines.length >= maxEntries) {
      if (depth > maxDepth) truncated = true;
      return;
    }
    let entries: LocalEntry[];
    try {
      entries = await localFs.list(dir);
    } catch {
      return; // unreadable dir — skip silently
    }
    let shown = entries;
    if (entries.length > maxDirEntries) {
      lines.push(`${"  ".repeat(depth)}… (${entries.length - maxDirEntries} more entries hidden)`);
      shown = entries.slice(0, maxDirEntries);
    }
    for (const e of shown) {
      if (lines.length >= maxEntries) {
        truncated = true;
        break;
      }
      const indent = "  ".repeat(depth);
      if (e.isDir) {
        dirCount++;
        lines.push(`${indent}${e.name}/`);
        if (visited.has(e.path)) {
          lines.push(`${indent}  … (symlink loop)`);
          continue;
        }
        visited.add(e.path);
        await walk(e.path, depth + 1);
      } else {
        fileCount++;
        bySize.push({ path: e.path, size: e.size });
        lines.push(`${indent}${e.name}`);
      }
    }
  }

  await walk(root, 0);
  bySize.sort((a, b) => b.size - a.size);
  return { tree: lines.join("\n"), fileCount, dirCount, truncated, bySize };
}

/** Format a byte count into a short human-readable string (B / KB / MB / GB / TB). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
