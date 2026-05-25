import type { Shruti } from "@shruti/shruti.js"

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
    await app.filesStorage.clearAll()
  }

  return { onClearCache }
}
