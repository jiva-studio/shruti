import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { LibraryItem, LibraryItemStatus } from "@lib/domain/libraryItem.js"
import type { TrackId } from "@lib/domain/core.js"
import { isPendingLibraryItem } from "@usecases/sync/index.js"
import { useShruti } from "@shruti/shruti.js"
import { requestSync } from "@shruti/services/syncEvents.js"
import { IngestGatewayError } from "@infra/ingest/http/ingestClient.js"

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

  /**
   * Trigger ingest of a lecture by URL through the orchestrator ingest API — the
   * SINGLE client→server path (chat never ingests). The orchestrator dedups a
   * re-add and restarts a dead-lettered job, so this one call serves BOTH a
   * fresh add and a retry. `requestSync` then surfaces the freshly-queued
   * `library_items` row. This does not write `library_items` itself — the server
   * authors it and it arrives over sync, keeping the store's pull-only invariant.
   *
   * PRO-gated: a non-subscriber (or a server `not_pro` rejection) is bounced to
   * the paywall. A transport failure surfaces as an error — it never falls back
   * to a chat turn.
   */
  async function addByUrl(url: string, hints?: { title?: string; author?: string }): Promise<void> {
    if (!url.trim()) return
    const { usePurchasesStore } = await import("@shruti/stores/usePurchasesStore.js")
    if (!usePurchasesStore().isSubscribed) {
      const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
      usePaywallStore().requestOpen()
      return
    }
    try {
      await app.ingestClient.submit({ url, title: hints?.title, author: hints?.author })
      requestSync()
    } catch (err) {
      if (err instanceof IngestGatewayError && err.code === "not_pro") {
        const { usePaywallStore } = await import("@shruti/stores/usePaywallStore.js")
        usePaywallStore().requestOpen()
        return
      }
      error.value = err instanceof Error ? err.message : "Failed to add lecture"
    }
  }

  /**
   * Patch an item's lifecycle status (and track id) from a live status poll,
   * ahead of the authoritative sync pull — the real-time bridge that flips a
   * card queued → processing → ready without waiting out the sync cadence. A
   * no-op when the item isn't in the store yet (its queued row hasn't synced) or
   * nothing changed. On a terminal transition the poller reconciles the full row
   * (audio keys, metadata) via requestSync.
   */
  function applyLiveStatus(id: string, status: LibraryItemStatus, trackId: TrackId | null): void {
    const idx = items.value.findIndex((i) => i.id === id)
    if (idx === -1) return
    const cur = items.value[idx]
    if (!cur) return
    const nextTrackId = trackId ?? cur.trackId
    if (cur.status === status && cur.trackId === nextTrackId) return
    const next = items.value.slice()
    next[idx] = { ...cur, status, trackId: nextTrackId }
    items.value = next
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
    addByUrl,
    applyLiveStatus,
  }
})

const YT_ID = /(?:youtube\.com\/(?:watch\?[^\s]*\bv=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i

function normalizeSource(url: string): string {
  const m = YT_ID.exec(url)
  return m ? `yt:${m[1]}` : url.trim()
}
