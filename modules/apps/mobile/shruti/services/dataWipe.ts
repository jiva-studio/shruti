import type { Shruti } from "../shruti.js"
import { resetContentDatabase } from "./contentDatabase.js"
import { useAutoDownloadFiltersStore } from "../stores/useAutoDownloadFiltersStore.js"
import { useChatStore } from "../stores/useChatStore.js"
import { useDownloadStore } from "../stores/useDownloadStore.js"
import { useIngestPollingStore } from "../stores/useIngestPollingStore.js"
import { useLibraryStore } from "../stores/useLibraryStore.js"
import { useNotesStore } from "../stores/useNotesStore.js"
import { usePlayerStore } from "../stores/usePlayerStore.js"
import { usePlaylistStore } from "../stores/usePlaylistStore.js"
import { useSearchFiltersStore } from "../stores/useSearchFiltersStore.js"

const PLAYER_STOP_TIMEOUT_MS = 5000

/** What to do with the local copy of the public lecture catalog. */
export interface WipeLocalUserDataOptions {
  /**
   * `"reset"` (default) deletes the downloaded catalog too — the departing
   * user's device keeps nothing, and the next cold start re-resolves it from
   * zero (welcome screen, foreground download, ~54 MB).
   *
   * `"keep"` spares it. The catalog is public content, byte-identical for
   * every user and holding nothing personal, so a wipe whose purpose is
   * privacy (sign-out, #1773) gains nothing by dropping it and costs the next
   * person a full re-download — a bad surprise on a metered connection.
   */
  readonly contentCatalog?: "reset" | "keep"
}

/**
 * Wipe every byte of local user state — notes, playlist, listening
 * history, the personal library, downloaded audio + transcript files, the
 * local content catalog, chat history, search filters, the sync journal, and
 * every Pinia store that mirrors them.
 *
 * Shared between the debug "Clear user data" action, the user-facing "Delete
 * account" flow and sign-out (#1773). They want the same all-or-nothing effect
 * on USER data and differ only in the confirm UX — which stays out of here,
 * the caller is responsible for getting consent — and in whether the public
 * catalog goes with it (see {@link WipeLocalUserDataOptions}). Everything the
 * wipe exists to remove is in the user database, the blob cache and the
 * preferences it clears unconditionally; the catalog is the one thing a caller
 * may spare, and it can be spared because the content databases hold nothing
 * per-user (the personal library lives in `library_items`, in the USER db).
 *
 * **Sync-aware (#1496).** A wipe that clears only the domain tables is not a
 * wipe, it is a divergence:
 *   - `library_items` left behind puts the whole personal library back on
 *     screen — including every item the user had REMOVED, because a removal is
 *     an `archived_at` row in `library_memberships` and ABSENCE MEANS ACTIVE
 *     (`ILibraryMembershipRepository`). Clearing memberships alone un-removes
 *     them; the two tables have to go together.
 *   - `outbox` left behind still describes the deleted documents, and nothing
 *     retires it: `owner_id` (023) only separates identities, so on a wipe that
 *     keeps the same account the next cycle pushes the stale rows and
 *     re-creates the wiped data server-side.
 *   - `sync_doc_hlc` left behind hands stale `base_hlc` values to unrelated
 *     future writes and makes `wasJournaled` claim a re-created chat document
 *     is already in sync.
 *
 * `sync_state` is deliberately NOT reset. Its `pull_cursor` is this device's
 * high-water mark in the server's change log; rewinding it to 0 would re-pull
 * everything the wipe just deleted and undo it within one cycle. A wipe is
 * device-local by design (see the sync-journal decorator's header) — the server
 * copy is meant to survive, just not to flow back. On the account-deletion path
 * the identity changes, and `useSyncEngine.maybeResetCursorForOwner` is what
 * resets the cursor for the account replacing it; that decision belongs there,
 * not here. `pushed_outbox_id` likewise stays put: `outbox.id` is AUTOINCREMENT,
 * so emptying the table does not rewind the sequence and later rows still land
 * above the watermark.
 *
 * Ordering matters:
 *   1. Stop playback — the engine may be holding a track row that's
 *      about to vanish, leaving the floating player pointing at a
 *      ghost. `stop()` is a no-op when nothing is open.
 *   2. On-disk wipes (repos + filesStorage + preferences). The
 *      filesStorage sweep is what keeps the audio + transcript blobs
 *      from orphaning on disk when their metadata rows are gone.
 *   3. In-memory Pinia caches — without this, Home/Search/Notes keep
 *      rendering the pre-wipe lists until the next cold start.
 */
export async function wipeLocalUserData(
  app: Shruti,
  opts: WipeLocalUserDataOptions = {}
): Promise<void> {
  const repos = app.repositories()
  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const notes = useNotesStore()
  const library = useLibraryStore()
  const downloads = useDownloadStore()
  const ingestPolling = useIngestPollingStore()
  const searchFilters = useSearchFiltersStore()
  const autoDownloadFilters = useAutoDownloadFiltersStore()
  const chat = useChatStore()

  // Bounded so a stalled audio engine (broken plugin state, native bug)
  // can't trap the whole wipe — better to leave a ghost track row than
  // to leave the user without a way to recover short of force-quitting.
  if (player.open) {
    try {
      await Promise.race([
        player.stop(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("player.stop timeout")), PLAYER_STOP_TIMEOUT_MS)
        ),
      ])
    } catch (err) {
      console.warn("[wipeLocalUserData] player.stop did not complete in 5s, continuing", err)
    }
  }

  // 1. On-disk wipe.
  await repos.notes.clearAll()
  await repos.playlistItems.clearAll()
  // Both halves of the personal library, in one transaction: the items and the
  // remove/re-add intents that qualify them. Either one surviving alone leaves
  // the shelf lying — items without memberships means every removed item is
  // back (absence = active).
  await repos.unitOfWork.run(async () => {
    await repos.libraryItems.clearAll()
    await repos.libraryMemberships.clearAll()
  })
  await repos.mediaItems.clearAll()
  await repos.listeningSessions.clearAll()
  // Chat sessions + messages live in the user DB; `chat.clearAll()`
  // also aborts any in-flight SSE stream, drops the preference-backed unread
  // badge + scroll anchors (#1784) and resets the in-memory store, so no
  // separate refresh is needed below.
  await chat.clearAll()
  // The sync journal, once every domain row it describes is gone. Present only
  // when the engine was wired (`getDeviceId`); without it nothing was ever
  // journaled and there is nothing to clear. One transaction so a half-cleared
  // journal — pending rows for deleted docs, or HLC pointers with no rows —
  // can never be observed by a cycle running alongside the wipe.
  if (repos.syncOutbox || repos.syncApply) {
    await repos.unitOfWork.run(async () => {
      await repos.syncOutbox?.clearAll()
      await repos.syncApply?.clearDocHlcs()
    })
  }
  // The cached audio + transcript files. Without this the rows above
  // are gone but the blobs on disk linger as orphans until the user
  // manually triggers "Clear cache".
  await app.filesStorage.clearAll()
  // …and the content catalog, which `clearAll()` deliberately spares (#1630).
  // A departing user's local copy genuinely should go; the next launch
  // re-downloads it from zero. Not on the sign-out path: nothing in it is the
  // signed-out user's, so dropping it buys no privacy and bills the next
  // person ~54 MB.
  if ((opts.contentCatalog ?? "reset") === "reset") await resetContentDatabase(app)
  await app.preferences.remove("search.filters.v3")
  // Legacy key from before #411; harmless if it doesn't exist.
  await app.preferences.remove("search.filters.v2")
  await app.preferences.remove("autoDownload.filters.v1")

  // 2. In-memory Pinia caches that mirror the wiped repos.
  //    - playlist & notes: refresh re-reads the (now empty) repos.
  //    - downloads: drop the per-track state map and force a
  //      re-hydrate from the (now empty) media-items repo on next
  //      access.
  //    - searchFilters / autoDownloadFilters: clear in-memory selection
  //      without re-writing preferences (we just removed the keys on
  //      disk); resetting `loaded` forces a re-hydrate on next access.
  //    - library: re-reads the (now empty) items + memberships, so the
  //      "My library" shelf empties instead of rendering the pre-wipe rows.
  //    - chat: already reset by chat.clearAll() above.
  //    - ingestPolling: a poll started before the wipe is still awaiting its
  //      answers, and they describe items that no longer exist; the reset
  //      retires that generation so none of them lands.
  await Promise.all([playlist.refresh(), notes.refresh(), library.refresh()])
  downloads.reset()
  ingestPolling.reset()
  searchFilters.reset()
  autoDownloadFilters.reset()
}
