/**
 * Multi-device account & config sync.
 *
 * Talks to the self-hosted Python sync server (Server/server.py):
 *   register / login  → Bearer token
 *   GET/POST /api/sync → whole-config push/pull (last-write-wins)
 *   GET/POST /api/profile → nickname + avatar
 *
 * What gets synced:
 *   - A whitelist of *cross-platform* settings (theme, language, AI config,
 *     approval settings, shortcuts, …). Machine-specific values
 *     (localShell, jlinkPath, importedFonts, sidebarCollapsed) are excluded —
 *     they differ per OS / per device.
 *   - The hosts list and quick commands (any kind; credentials are stored
 *     plaintext on the server — it is your own deployment, see Server/README).
 *   - Nickname / avatar (server profile).
 * Nothing sensitive about the sync *server* (serverUrl / token) is synced.
 */
import { useAppStore, DEFAULT_SETTINGS } from "@/store/useAppStore";
import { useHostsStore } from "@/store/useHostsStore";
import { tFrom } from "@/i18n";
import { invoke } from "@tauri-apps/api/core";
import type { Host, QuickCommand } from "@/lib/types";

/** Settings keys shared across platforms. Everything else stays device-local. */
export const SYNC_SETTING_KEYS = [
  "theme",
  "language",
  "fontFamily",
  "fontSize",
  "lineHeight",
  "cursorBlink",
  "cursorStyle",
  "cursorColor",
  "cursorInactiveStyle",
  "scrollback",
  "copyOnSelect",
  "metricsInterval",
  "confirmOnClose",
  "approveShortcut",
  "approvalNotifications",
  "approval",
  "autoCheckUpdates",
  "autoDownloadUpdates",
  "ai",
] as const;

export interface SyncData {
  settings: Record<string, unknown>;
  hosts: Host[];
  quickCommands: QuickCommand[];
}

export interface Profile {
  nickname: string;
  avatar: string;
}

// ------------------------------------------------------------------ HTTP
//
// Requests go through the Rust `sync_fetch` command (reqwest), NOT browser
// fetch: the packaged page runs on https://tauri.localhost, and browser-level
// restrictions (CSP connect-src, mixed content, Chromium Private Network
// Access) would block calls to a self-hosted plain-http sync server. reqwest
// is not subject to any of them.

async function api<T>(
  url: string,
  method: "GET" | "POST",
  token: string | null,
  body?: unknown,
): Promise<T> {
  let status: number;
  let text: string;
  try {
    [status, text] = await invoke<[number, string]>("sync_fetch", {
      method,
      url,
      token: token || null,
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch {
    // Transport failure (server unreachable / wrong URL / DNS). Surface
    // something actionable instead of the raw error.
    throw new Error(tFrom(useAppStore.getState().settings.language, "sync.networkError"));
  }
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = {};
  }
  if (status >= 400) throw new Error((data.error as string) || `HTTP ${status}`);
  return data as T;
}

function base(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

// ------------------------------------------------------------------ auth

export async function registerAccount(
  serverUrl: string,
  username: string,
  password: string,
): Promise<{ token: string; nickname: string; avatar: string }> {
  return api(`${base(serverUrl)}/api/register`, "POST", null, { username, password });
}

export async function loginAccount(
  serverUrl: string,
  username: string,
  password: string,
): Promise<{ token: string; nickname: string; avatar: string }> {
  return api(`${base(serverUrl)}/api/login`, "POST", null, { username, password });
}

// ------------------------------------------------------------------ sync

function collectSyncData(): SyncData {
  const s = useAppStore.getState().settings;
  const { hosts, quickCommands } = useHostsStore.getState();
  const settings: Record<string, unknown> = {};
  for (const k of SYNC_SETTING_KEYS) settings[k] = s[k];
  return { settings, hosts, quickCommands };
}

/** Push the current local state to the server (last-write-wins). */
export async function pushSyncData(serverUrl: string, token: string): Promise<void> {
  const data = collectSyncData();
  await api(`${base(serverUrl)}/api/sync`, "POST", token, { data });
  useAppStore.getState().updateSetting("account", {
    ...useAppStore.getState().settings.account,
    lastSyncAt: Date.now(),
  });
}

/** Apply remote data onto the local stores (settings whitelist + hosts + commands). */
export async function applySyncData(data: Partial<SyncData>): Promise<void> {
  const remoteSettings = (data.settings ?? {}) as Record<string, unknown>;
  const local = useAppStore.getState().settings;
  const updateSetting = useAppStore.getState().updateSetting;

  // Settings: apply each whitelisted key that differs. Nested objects are
  // merged field-by-field so a remote payload from an older build can never
  // clobber newer keys with `undefined`.
  for (const k of SYNC_SETTING_KEYS) {
    const remote = remoteSettings[k];
    if (remote === undefined) continue;
    if (k === "ai" || k === "approval") {
      const merged = {
        ...(DEFAULT_SETTINGS[k] as unknown as Record<string, unknown>),
        ...(remote as Record<string, unknown>),
      };
      if (k === "approval" && typeof remote === "object" && remote !== null) {
        merged.tools = {
          ...((DEFAULT_SETTINGS.approval.tools as unknown as Record<string, unknown>) ?? {}),
          ...(((remote as Record<string, unknown>).tools as Record<string, unknown>) ?? {}),
        };
      }
      if (JSON.stringify(merged) !== JSON.stringify(local[k])) {
        await updateSetting(k, merged as never);
      }
      continue;
    }
    if (JSON.stringify(remote) !== JSON.stringify(local[k])) {
      await updateSetting(k, remote as never);
    }
  }

  // Hosts: the server holds the latest writer's state — reconcile to it, but
  // ONLY when the remote payload actually carries the field. A brand-new
  // account has `data: {}` on the server; applying an implicit empty list
  // would wipe this device's hosts before the user ever pushed anything.
  const hs = useHostsStore.getState();
  if (data.hosts !== undefined) {
    const remoteHosts = data.hosts as Host[];
    const remoteCommands = (data.quickCommands ?? []) as QuickCommand[];
    for (const h of hs.hosts) {
      if (!remoteHosts.some((r) => r.id === h.id)) await hs.deleteHost(h.id);
    }
    for (const h of remoteHosts) await hs.saveHost(h);
    for (const c of hs.quickCommands) {
      if (!remoteCommands.some((r) => r.id === c.id)) await hs.deleteQuickCommand(c.id);
    }
    for (const c of remoteCommands) await hs.saveQuickCommand(c);
  } else if (data.quickCommands !== undefined) {
    const remoteCommands = data.quickCommands as QuickCommand[];
    for (const c of hs.quickCommands) {
      if (!remoteCommands.some((r) => r.id === c.id)) await hs.deleteQuickCommand(c.id);
    }
    for (const c of remoteCommands) await hs.saveQuickCommand(c);
  }
}

/** Pull the remote state and apply it locally. Returns true on success. */
export async function pullSyncData(serverUrl: string, token: string): Promise<boolean> {
  const res = await api<{ data: Partial<SyncData> }>(
    `${base(serverUrl)}/api/sync`,
    "GET",
    token,
  );
  if (res.data) await applySyncData(res.data);
  useAppStore.getState().updateSetting("account", {
    ...useAppStore.getState().settings.account,
    lastSyncAt: Date.now(),
  });
  return true;
}

/** One-shot "sync now": push the local state (this device's changes win, as
 *  the user explicitly initiated the sync), then pull the reconciled remote
 *  state back so every device ends up identical. */
export async function syncNow(): Promise<void> {
  const a = useAppStore.getState().settings.account;
  if (!a.serverUrl || !a.token) throw new Error("not logged in");
  await pushSyncData(a.serverUrl, a.token);
  await pullSyncData(a.serverUrl, a.token);
}

// ------------------------------------------------------------------ profile

/** Save nickname / avatar to the server and mirror them locally. */
export async function saveProfile(
  serverUrl: string,
  token: string,
  nickname?: string,
  avatar?: string,
): Promise<Profile> {
  const body: Record<string, string> = {};
  if (nickname !== undefined) body.nickname = nickname;
  if (avatar !== undefined) body.avatar = avatar;
  const profile = await api<Profile>(`${base(serverUrl)}/api/profile`, "POST", token, body);
  useAppStore.getState().updateSetting("account", {
    ...useAppStore.getState().settings.account,
    nickname: profile.nickname,
    avatar: profile.avatar,
  });
  return profile;
}

/** Clear the local login (token + identity), keeping the server address. */
export function logoutAccount(): void {
  useAppStore.getState().updateSetting("account", {
    ...useAppStore.getState().settings.account,
    username: "",
    token: "",
    nickname: "",
    avatar: "",
    lastSyncAt: 0,
  });
}
