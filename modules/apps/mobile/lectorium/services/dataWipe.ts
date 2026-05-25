import type { Lectorium } from "../lectorium.js"
import { useAutoDownloadFiltersStore } from "../stores/useAutoDownloadFiltersStore.js"
import { useChatStore } from "../stores/useChatStore.js"
import { useDownloadStore } from "../stores/useDownloadStore.js"
import { useNotesStore } from "../stores/useNotesStore.js"
import { usePlayerStore } from "../stores/usePlayerStore.js"
import { usePlaylistStore } from "../stores/usePlaylistStore.js"
import { useSearchFiltersStore } from "../stores/useSearchFiltersStore.js"

const PLAYER_STOP_TIMEOUT_MS = 5000

/**
 * Wipe every byte of local user state — notes, playlist, listening
 * history, downloaded audio + transcript files, chat history, search
 * filters, and every Pinia store that mirrors them.
 *
 * Shared between the debug "Clear user data" action and the upcoming
 * user-facing "Delete account" flow. Both want the same all-or-nothing
 * effect; only the confirm UX differs, so the dialog stays out of here
 * and the caller is responsible for getting consent.
 *
 * Ordering matters:
 *   1. Stop playback — the engine may be holding a track row that's
 *      about to vanish, leaving the floating player pointing at a
 *      ghost. `stop()` is a no-op when nothing is open.
 *   2. On-disk wipes (repos + filesStorage + preferences). Doing the
 *      file-storage sweep here too is what closes issue #X's gap:
 *      previously `mediaItems` rows were deleted but the audio blobs
 *      on disk were orphaned forever.
 *   3. In-memory Pinia caches — without this, Home/Search/Notes keep
 *      rendering the pre-wipe lists until the next cold start.
 */
export async function wipeLocalUserData(app: Lectorium): Promise<void> {
  const repos = app.repositories()
  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const notes = useNotesStore()
  const downloads = useDownloadStore()
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
  await repos.mediaItems.clearAll()
  await repos.listeningSessions.clearAll()
  // Chat sessions + messages live in the user DB; `chat.clearAll()`
  // also aborts any in-flight SSE stream and resets the in-memory
  // store, so no separate refresh is needed below.
  await chat.clearAll()
  // The cached audio + transcript files. Without this the rows above
  // are gone but the blobs on disk linger as orphans until the user
  // manually triggers "Clear cache".
  await app.filesStorage.clearAll()
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
  //    - chat: already reset by chat.clearAll() above.
  await Promise.all([playlist.refresh(), notes.refresh()])
  downloads.reset()
  searchFilters.reset()
  autoDownloadFilters.reset()
}
