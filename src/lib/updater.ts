import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useUpdaterStore } from "@/store/useUpdaterStore";

/**
 * Check GitHub Releases for a newer version.
 *
 * - When an update is found, the pending `Update` is stored and the dialog opens.
 * - When `notifyWhenCurrent` is set, the dialog also opens (showing "up to date")
 *   even if nothing newer exists — used by the manual "Check for updates" button.
 */
export async function checkForUpdate(notifyWhenCurrent = false): Promise<void> {
  const s = useUpdaterStore.getState();
  s.setChecking(true);
  s.setError(null);
  try {
    const update = await check();
    if (update) {
      s.setUpdating(update);
      s.setOpen(true);
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
    await update.downloadAndInstall((event) => {
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
    });
    // On Windows/Linux the installer replaces the binary; relaunch finishes the
    // hand-off. On macOS the bundle is swapped and relaunch restarts us. Ignore
    // errors here — the process may already be mid-restart.
    await relaunch().catch(() => {});
  } catch (e) {
    s.setDownloading(false);
    s.setError(e instanceof Error ? e.message : String(e));
  }
}
