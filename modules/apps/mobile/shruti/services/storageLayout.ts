/**
 * Where the app is allowed to put bytes on disk.
 *
 * There is exactly one storage root, and everything the app writes lives
 * under it. That is the whole point of this module: the wipe
 * (`filesStorage.clearAll()`, used by both "Clear cache" and account
 * deletion) enumerates {@link MEDIA_ROOT_DIR} and nothing else, so a
 * directory outside it is a directory no wipe can ever reach.
 */

/**
 * Root of every app-managed download under `Directory.Data` — track audio,
 * transcripts, the content databases, and the share artifacts below.
 */
declare const __APP_NAME__: string | undefined

export const MEDIA_ROOT_DIR = (typeof __APP_NAME__ !== "undefined" && __APP_NAME__) || "shruti"

/**
 * Rendered share artifacts: Studio videos (which embed the user's own note
 * text), note audio excerpts, transcript PDFs, and the inline verse /
 * citation recitations.
 *
 * Under the storage root, not in `Directory.Cache`, which no sweep enumerates.
 * These are the most private bytes the app writes; being here makes them
 * ordinary collateral of the existing sweep ("Clear cache", "Delete account
 * and also delete data on this device") instead of needing a second one.
 *
 * They deliberately get NO `media_items` row, unlike the full-lecture audio
 * `useShareTrack` adopts via `adoptCachedFile`. That table is keyed by track
 * id and models the offline LECTURE set; a per-note video or a per-(track,
 * language) PDF has no track-scoped identity to occupy, and writing one would
 * make the lecture read as downloaded and let `evict()` delete a file the
 * player then resolves. Reclaimability comes from the sweep instead: this
 * directory is not in the `keep` list, so "Clear cache" takes it.
 */
export const EXCERPTS_DIR = `${MEDIA_ROOT_DIR}/excerpts`
