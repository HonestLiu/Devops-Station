import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useUpdaterStore } from "@/store/useUpdaterStore";
import { useAppStore } from "@/store/useAppStore";

/**
 * Optional GitHub token used to fetch the updater manifest / assets from a
 * PRIVATE repository. For a public repo this is unnecessary and should be left
 * unset.
 *
 * Read at BUILD TIME from the `VITE_GITHUB_UPDATER_TOKEN` env var (kept out of
 * git via `.env.local`, which is already gitignored). Use a fine-grained
 * Personal Access Token scoped to **Contents: Read** on this single repo.
 *
 * Note: the value is inlined into the shipped binary, so it is recoverable by
 * anyone with the app. For a private internal tool this is an acceptable
 * trade-off; if you'd rather not ship a token, make the repo public instead.
 */
const UPDATER_TOKEN = import.meta.env
  .VITE_GITHUB_UPDATER_TOKEN as string | undefined;

/** Authorization header for private-repo fetches, or `undefined` for public. */
function updaterHeaders(): HeadersInit | undefined {
  return UPDATER_TOKEN ? { Authorization: `Bearer ${UPDATER_TOKEN}` } : undefined;
}

/**
 * Check GitHub Releases for a newer version.
 *
 * - When an update is found, the pending `Update` is stored and the dialog opens.
 * - When `notifyWhenCurrent` is set, the dialog also opens (showing "up to date")
 *   even if nothing newer exists — used by the manual "Check for updates" button.
 * - When `auto` is set (startup background check), and the user opted into
 *   `autoDownloadUpdates`, the install starts immediately instead of waiting for
 *   the user to click "Update now".
 */
export async function checkForUpdate(
  notifyWhenCurrent = false,
  auto = false,
): Promise<void> {
  const s = useUpdaterStore.getState();
  s.setChecking(true);
  s.setError(null);
  try {
    const update = await check({ headers: updaterHeaders() });
    if (update) {
      s.setUpdating(update);
      s.setOpen(true);
      if (auto && useAppStore.getState().settings.autoDownloadUpdates) {
        // Skip the "click to update" step for the silent startup check.
        void installUpdate();
      }
    } else if (notifyWhenCurrent) {
      s.setError("upToDate");
      s.setOpen(true);
    }
  } catch (e) {
    s.setError(e instanceof Error ? e.message : String(e));
    if (notifyWhenCurrent) s.setOpen(true);
  } finally {
    s.setChecking(false);
  }
}

/**
 * Download + install the pending update, streaming progress into the store, then
 * relaunch the app so the new build takes over. Failures are reported via the
 * store (the dialog keeps showing so the user can retry / read the error).
 */
export async function installUpdate(): Promise<void> {
  const update = useUpdaterStore.getState().update;
  if (!update) return;

  const s = useUpdaterStore.getState();
  s.setDownloading(true);
  s.setProgress(0, 0);
  s.setError(null);

  let downloaded = 0;
  try {
    await update.downloadAndInstall(
      (event) => {
      const st = useUpdaterStore.getState();
      if (event.event === "Started") {
        st.setProgress(0, event.data.contentLength ?? 0);
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength ?? 0;
        // Some servers omit Content-Length; fall back to a moving bar.
        const total = st.total > 0 ? st.total : downloaded;
        st.setProgress(downloaded, total);
      } else if (event.event === "Finished") {
        const total = useUpdaterStore.getState().total;
        st.setProgress(total > 0 ? total : downloaded, total > 0 ? total : downloaded);
      }
    }, { headers: updaterHeaders() });
    // On Windows/Linux the installer replaces the binary; relaunch finishes the
    // hand-off. On macOS the bundle is swapped and relaunch restarts us. Ignore
    // errors here — the process may already be mid-restart.
    await relaunch().catch(() => {});
  } catch (e) {
    s.setDownloading(false);
    s.setError(e instanceof Error ? e.message : String(e));
  }
}
