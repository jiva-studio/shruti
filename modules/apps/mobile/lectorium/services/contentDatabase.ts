import { deriveParentDir, pruneContentDatabases, type ContentDatabaseStore } from "@kit/bootstrap"
import type { Lectorium } from "../lectorium.js"
import { DEFAULT_APP_CONFIG } from "./app.config.js"

/** Suffix the native bundled-catalog helpers copy under before renaming into
 *  place (`BundledDatabaseHelper.java` / `.swift`, `TEMP_SUFFIX`). */
const COPY_TEMP_SUFFIX = ".copying"

/**
 * Entry under the files-storage root that holds the database files. Derived
 * from the configured template so it can't drift from where the fetcher
 * actually writes. `filesStorage.clearAll()` is handed this to keep.
 */
export const DATABASES_DIR =
  deriveParentDir(DEFAULT_APP_CONFIG.database.localPathTemplate).split("/").pop() ?? "databases"

/**
 * Delete the local content catalog — the "Delete database" verb, as opposed
 * to "Clear cache" (`filesStorage.clearAll()`, which now leaves the catalog
 * alone). Nothing re-seeds it in-app, so the next cold start re-resolves from
 * zero: welcome screen, foreground download, ~54 MB. That cost is the point
 * of the action, which is why only deliberate callers get it.
 *
 * The user DB lives in the same directory and is deliberately NOT touched:
 * it is wiped row-by-row by `wipeLocalUserData`, which keeps `sync_state`
 * on purpose (see its header) — dropping the file would rewind the pull
 * cursor and re-pull everything the wipe just deleted.
 */
export async function resetContentDatabase(app: Lectorium): Promise<void> {
  await pruneContentDatabases(app.databaseFetcher, app.appConfig.database.localPathTemplate, null)
  await sweepCatalogCopyTemps(app.databaseFetcher, app.appConfig.database.localPathTemplate)
}

/**
 * Delete `*.copying` leftovers in the catalog directory and return what went.
 *
 * The native bundled-catalog helpers copy to a temp neighbour and rename it
 * into place, and clear that temp only from inside their own copy step. Once
 * the JS bootstrap has downloaded a catalog at or above the bundled version
 * that step is never entered again (`shouldCopy` is false), so a temp left by
 * a kill mid-copy is orphaned for good: it matches neither the versioned
 * pattern `pruneContentDatabases` sweeps nor the `.download` suffix the
 * fetcher cleans up, which is up to ~54 MB invisible to "Clear cache" (#1896).
 *
 * Runs alongside the prune, so catalog-directory hygiene stays in one place.
 * Safe against a copy in flight: the native helper runs synchronously at
 * launch (`AppDelegate` / `MainActivity`), long before any JS executes.
 *
 * Best-effort, like the prune: a failed delete is skipped, not thrown.
 */
export async function sweepCatalogCopyTemps(
  store: Pick<ContentDatabaseStore, "list" | "delete">,
  localPathTemplate: string
): Promise<string[]> {
  const parentDir = deriveParentDir(localPathTemplate)
  let files: readonly string[]
  try {
    files = await store.list(parentDir)
  } catch {
    return []
  }

  const swept: string[] = []
  for (const entry of files) {
    const name = entry.substring(entry.lastIndexOf("/") + 1)
    if (!name.endsWith(COPY_TEMP_SUFFIX)) continue
    const path = parentDir ? `${parentDir}/${name}` : name
    try {
      await store.delete(path)
      swept.push(path)
    } catch {
      // Locked or already gone — leave it for the next launch.
    }
  }
  return swept
}
