import type { Shruti } from "@shruti/shruti.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { useDownloadUseCases } from "@shruti/wiring/downloadUseCases.js"

export interface UseDangerActionsReturn {
  /** Wipes the on-disk media cache. Does not touch user records. */
  onClearCache: () => Promise<void>
}

/**
 * Bundles the destructive Settings actions so the view stays free of
 * direct repository imports. Only "Clear cache" lives here; the
 * full-account wipe is `wipeLocalUserData`, exposed via the user-facing
 * "Delete account" flow.
 */
export function useDangerActions(app: Shruti): UseDangerActionsReturn {
  const downloads = useDownloadUseCases(app)

  async function onClearCache(): Promise<void> {
    // A cache reset, not a data wipe: user records stay, and so does the
    // content catalog — re-fetching it costs ~54 MB and takes the app offline.
    await downloads.clearMediaCache()
    // Drop the in-memory per-track state map (and cancel/abandon any in-flight
    // transfers) so the offline indicators across the app reflect the now-empty
    // cache without waiting for a re-hydrate.
    useDownloadStore().reset()
  }

  return { onClearCache }
}
