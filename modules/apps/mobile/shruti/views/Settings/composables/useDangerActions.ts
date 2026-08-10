import type { Shruti } from "@shruti/shruti.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"

export interface UseDangerActionsReturn {
  /** Wipes the on-disk media cache. Does not touch user records. */
  onClearCache: () => Promise<void>
}

/**
 * Bundles the destructive Settings actions so the view stays free of
 * direct repository imports. Currently only "Clear cache" — the
 * full-account wipe moved to `wipeLocalUserData` and is exposed via the
 * user-facing "Delete account" flow instead of the debug surface.
 */
export function useDangerActions(app: Shruti): UseDangerActionsReturn {
  async function onClearCache(): Promise<void> {
    // Delete the cached audio + transcript blobs, then drop the media-items
    // index that points at them. Without clearing the index, every cleared
    // track keeps showing "downloaded" and tapping play resolves to a file
    // that's gone ("can't play offline"). User records — notes, playlist,
    // listening history, chat — are deliberately left untouched; this is a
    // cache reset, not a data wipe. Neither is the content catalog: it is not
    // cache, and re-fetching it costs ~54 MB and takes the app offline
    // meanwhile (#1630).
    await app.filesStorage.clearAll()
    await app.repositories().mediaItems.clearAll()
    // Drop the in-memory per-track state map (and cancel/abandon any in-flight
    // transfers) so the offline indicators across the app reflect the now-empty
    // cache without waiting for a re-hydrate.
    useDownloadStore().reset()
  }

  return { onClearCache }
}
