import { deriveParentDir, pruneContentDatabases } from "@kit/bootstrap"
import type { Lectorium } from "../lectorium.js"
import { DEFAULT_APP_CONFIG } from "./app.config.js"

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
}
