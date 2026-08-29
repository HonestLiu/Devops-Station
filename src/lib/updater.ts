import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { useUpdaterStore } from "@/store/useUpdaterStore";
import { useAppStore } from "@/store/useAppStore";
import { call } from "@/lib/api";
import type { UpdateInfo } from "@/store/useUpdaterStore";

/**
 * Optional GitHub mirror used to accelerate update downloads. The mirror is a
 * URL *prefix* applied to the asset download URL, e.g.
 * `https://github.dpik.top/https://github.com/HonestLiu/Devops-Station/releases/download/v0.1.34/DevOps.Station_0.1.34_amd64.deb`.
 *
 * The prefix is read from Settings → Updates (`githubMirror`). Empty = download
 * directly from GitHub (no acceleration). The bytes still carry the original
 * signature, so update verification is unaffected.
 */
function githubMirror(): string {
  return (useAppStore.getState().settings.githubMirror ?? "").trim();
}

function mirrorArg(): string | null {
  const m = githubMirror();
  return m ? m : null;
}

/**
 * Check GitHub Releases for a newer version.
 *
 * - When an update is found, its summary is stored and the dialog opens.
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
    const info = await call<UpdateInfo | null>("updater_check", {
      mirror: mirrorArg(),
    });
    if (info) {
      s.setUpdating(info);
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
 * Download + install the pending update (delegating to the Rust side, which
 * applies the GitHub mirror and streams progress via `updater://progress`
 * events), then relaunch the app so the new build takes over.
 */
export async function installUpdate(): Promise<void> {
  const update = useUpdaterStore.getState().update;
  if (!update) return;

  const s = useUpdaterStore.getState();
  s.setDownloading(true);
  s.setProgress(0, 0);
  s.setError(null);

  let downloaded = 0;
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<{ kind: string; chunk: number; total: number | null }>(
      "updater://progress",
      (ev) => {
        const st = useUpdaterStore.getState();
        if (ev.payload.kind === "progress") {
          downloaded += ev.payload.chunk;
          const total = ev.payload.total ?? downloaded;
          st.setProgress(downloaded, total);
        } else if (ev.payload.kind === "finished") {
          const total = st.total > 0 ? st.total : downloaded;
          st.setProgress(total, total);
        }
      },
    );

    await call("updater_download_and_install", { mirror: mirrorArg() });
    // On Windows/Linux the installer replaces the binary; relaunch finishes the
    // hand-off. On macOS the bundle is swapped and relaunch restarts us. Ignore
    // errors here — the process may already be mid-restart.
    await relaunch().catch(() => {});
  } catch (e) {
    s.setDownloading(false);
    s.setError(e instanceof Error ? e.message : String(e));
  } finally {
    unlisten?.();
  }
}
