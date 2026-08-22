/**
 * Cross-device data sync through object storage (S3-compatible / MinIO /
 * Tencent COS / Cloudflare R2).
 *
 * Replaces the old self-hosted Python account server. There is no account or
 * login: the user configures their own object-storage bucket, and every device
 * that points at the same bucket can push/pull a single profile object.
 *
 * What gets synced (nearly everything, for a seamless move to a new device):
 *   - All cross-platform settings, EXCEPT purely device-specific ones
 *     (localShell, jlinkPath, importedFonts, sidebarCollapsed) which are
 *     stripped on push by the backend (`profile_doc`).
 *   - The hosts list and quick commands, including saved passwords when
 *     `includeSecrets` is on (default) — so cloud-server credentials work on
 *     every synced device without re-entering them.
 *   - Imported fonts.
 *   - The user's display name (`username`) and avatar — synced identity info.
 *
 * What is intentionally NOT synced:
 *   - The object-storage config itself (`sync` setting) — it's local
 *     credentials, so one device can never hijack another's sync target. The
 *     backend also strips the remote `sync` block on pull as a belt-and-braces
 *     measure.
 *
 * The actual transport (AWS SigV4 over reqwest) lives in the Rust `sync`
 * module; this file is a thin typed wrapper around the `sync_test` /
 * `sync_push` / `sync_pull` Tauri commands. `deviceId` is injected by the
 * backend, so we never send it from the frontend.
 */
import { useAppStore } from "@/store/useAppStore";
import { tFrom } from "@/i18n";
import { invoke } from "@tauri-apps/api/core";
import type { SyncConfig } from "@/lib/types";

/** Read the (local) object-storage sync config from the store. */
export function getSyncConfig(): SyncConfig {
  return useAppStore.getState().settings.sync;
}

/** Whether a sync target has been configured. */
export function isSyncConfigured(): boolean {
  const s = getSyncConfig();
  return (
    s.endpoint.trim() !== "" &&
    s.bucket.trim() !== "" &&
    s.accessKeyId.trim() !== "" &&
    s.secretAccessKey.trim() !== ""
  );
}

/** Verify the bucket + credentials are reachable (HEAD the sync object). */
export async function testConnection(): Promise<{ success: boolean; message: string }> {
  if (!isSyncConfigured()) {
    throw new Error(tFrom(useAppStore.getState().settings.language, "settings.sync.needConfig"));
  }
  const res = await invoke<{ success: boolean; status: number; message: string }>(
    "sync_test",
    { cfg: getSyncConfig() },
  );
  if (!res.success) throw new Error(res.message);
  return { success: true, message: res.message };
}

/** Upload the local profile to object storage (local changes win). */
export async function pushSync(): Promise<void> {
  if (!isSyncConfigured()) {
    throw new Error(tFrom(useAppStore.getState().settings.language, "settings.sync.needConfig"));
  }
  await invoke("sync_push", { cfg: getSyncConfig() });
  markSynced();
}

/** Download the remote profile and merge it into the local database. */
export async function pullSync(): Promise<void> {
  if (!isSyncConfigured()) {
    throw new Error(tFrom(useAppStore.getState().settings.language, "settings.sync.needConfig"));
  }
  await invoke("sync_pull", { cfg: getSyncConfig() });
  markSynced();
}

/**
 * One-shot "sync now": push the local state first (this device's changes win,
 * as the user explicitly initiated the sync), then pull the reconciled remote
 * state back so every device ends up identical.
 */
export async function syncNow(): Promise<void> {
  await pushSync();
  await pullSync();
}

/**
 * Save the user's display name / avatar and immediately push so the new
 * identity is available on every synced device without a separate sync step.
 */
export async function saveIdentity(username: string, avatar: string): Promise<void> {
  await useAppStore.getState().updateSetting("username", username);
  await useAppStore.getState().updateSetting("avatar", avatar);
  if (isSyncConfigured()) {
    try {
      await pushSync();
    } catch {
      // Identity is still saved locally; the next sync will carry it.
    }
  }
}

/** Persist the last-successful-sync timestamp. */
function markSynced(): void {
  const sync = { ...getSyncConfig(), lastSyncAt: Date.now() };
  void useAppStore.getState().updateSetting("sync", sync);
}
