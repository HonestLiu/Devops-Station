/**
 * Single source of truth for which OS this app is running on.
 *
 * In a Tauri desktop webview `navigator.platform` / `navigator.userAgent`
 * reliably reflect the host OS, so we can gate Windows-only features (WSL,
 * USB Device Manager) synchronously at render time without an async IPC call.
 * Previously each component sniffed the platform with its own regex
 * (Sidebar.tsx for ⌘K, Settings.tsx for the WSL section) — this centralizes
 * that so feature gating stays consistent app-wide.
 */

function detect(): "windows" | "macos" | "linux" | "other" {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/win/i.test(ua) || /win/i.test(platform)) return "windows";
  if (/mac|iphone|ipad|ipod/i.test(platform) || /macintosh|mac os/i.test(ua)) {
    return "macos";
  }
  if (/linux/i.test(ua) || /linux/i.test(platform)) return "linux";
  return "other";
}

export const platform = detect();
export const isWindows = platform === "windows";
export const isMac = platform === "macos";
export const isLinux = platform === "linux";
