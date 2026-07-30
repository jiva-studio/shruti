import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { LibraryItem } from "@lib/domain/libraryItem.js"
import { isPendingLibraryItem } from "@usecases/sync/index.js"
import { useShruti } from "@shruti/shruti.js"

/**
 * Single source of truth for the user's **personal library** — lectures the
 * user added that are not in the shared corpus (epic #1236). Mirrors
 * `usePlaylistStore` in shape, but read-only: `library_items` is a server-owned,
 * pull-only synced collection, so this store never writes it. It just projects
 * the on-device rows (via `ILibraryItemRepository`) into the "My library" shelf
 * (Search tab) and the full `MyLibraryView`, and `useSyncEngine.refreshStores`
 * calls `refresh()` when a pull merges new `library_items`.
 *
 * NOTE: distinct from `useLibraryLandingStore` (Search landing sections) and
 * `useLibraryLanguages` (content-language facet) — "library" is overloaded in
 * this app; this one is the *personal* library.
 */
export const useLibraryStore = defineStore("personalLibrary", () => {
  const app = useShruti()

  const items = ref<readonly LibraryItem[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loaded = false

  /** Items still being ingested (server will flip them to ready/failed). */
  const pendingItems = computed(() => items.value.filter(isPendingLibraryItem))
  const hasPending = computed(() => pendingItems.value.length > 0)
  const isEmpty = computed(() => items.value.length === 0)

  async function refresh(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      // Always present (does not depend on the sync `getDeviceId` gate); the
      // sync-apply adapter fills the table when the engine runs.
      items.value = await app.repositories().libraryItems.listAll()
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load library"
      // Keep the last-good list (don't blank the shelf on a transient read
      // failure), and leave `loaded` false so `ensureLoaded` retries rather than
      // sticking on an empty view forever. refreshStores also re-runs on the
      // next successful pull.
      loaded = false
    } finally {
      isLoading.value = false
    }
  }

  /** Lazy refresh — only refetches if we've never loaded. Cheap to call from
   *  every view's `onMounted`. */
  async function ensureLoaded(): Promise<void> {
    if (!loaded) await refresh()
  }

  function getById(id: string): LibraryItem | undefined {
    return items.value.find((i) => i.id === id)
  }

  /** Whether a source URL is already in the library — used to mark a search
   *  candidate the user has added before. Matches on the normalized source
   *  (YouTube URL variants collapse to their video id, mirroring the server). */
  function hasSource(url: string): boolean {
    if (!url.trim()) return false
    const key = normalizeSource(url)
    return items.value.some((i) => i.sourceUrl != null && normalizeSource(i.sourceUrl) === key)
  }

  return {
    items,
    isLoading,
    error,
    pendingItems,
    hasPending,
    isEmpty,
    refresh,
    ensureLoaded,
    getById,
    hasSource,
  }
})

const YT_ID = /(?:youtube\.com\/(?:watch\?[^\s]*\bv=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i

function normalizeSource(url: string): string {
  const m = YT_ID.exec(url)
  return m ? `yt:${m[1]}` : url.trim()
}
