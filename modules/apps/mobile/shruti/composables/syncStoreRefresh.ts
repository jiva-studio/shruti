import { useChatStore } from "@shruti/stores/useChatStore.js"
import { useLibraryStore } from "@shruti/stores/useLibraryStore.js"
import { useNotesStore } from "@shruti/stores/useNotesStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import { reportError } from "@shruti/services/monitoring/reportError.js"

/**
 * Refresh the Pinia stores whose collections a sync cycle changed. Stores do
 * not observe SQLite, so a merged batch reaches the screen only through this.
 * Each refresh is best-effort: a failing store is reported, leaves its previous
 * list up, and the next cycle refreshes it again.
 */
export async function refreshStoresFor(collections: readonly string[]): Promise<void> {
  if (collections.includes("playlist_items") || collections.includes("listening_sessions")) {
    await usePlaylistStore()
      .refresh()
      .catch((err: unknown) => reportError("sync", err))
  }
  if (collections.includes("notes")) {
    await useNotesStore()
      .refresh()
      .catch((err: unknown) => reportError("sync", err))
  }
  // Chat: a merged session / message batch changes the history list.
  if (collections.includes("chat_sessions") || collections.includes("chat_messages")) {
    await useChatStore()
      .refreshSessions()
      .catch((err: unknown) => reportError("sync", err))
  }
  if (collections.includes("library_items") || collections.includes("library_memberships")) {
    // Personal library is pull-only and server-owned. Refresh the
    // "My library" store so the shelf/list + status badges reflect the merged
    // rows (e.g. an item flipping processing → ready) on whatever screen is
    // up. The poll loop shortens the cadence while any item is pending so this
    // fires within seconds, not the flat idle interval.
    await useLibraryStore()
      .refresh()
      .catch((err: unknown) => reportError("sync", err))
  }
}
