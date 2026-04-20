import { defineStore } from "pinia"
import { computed, ref } from "vue"
import {
  addTrackToPlaylist,
  type AddTrackToPlaylistError,
} from "@lib/application/addTrackToPlaylist.js"
import {
  archivePlaylistItem,
  type ArchivePlaylistItemError,
} from "@lib/application/archivePlaylistItem.js"
import { listActivePlaylistTracks } from "@lib/application/listPlaylistTracks.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { Track } from "@lib/domain/track.js"
import type { Result } from "@lib/domain/result.js"
import { useShruti } from "@shruti/shruti.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"

export interface PlaylistEntry {
  readonly item: PlaylistItem
  readonly track: Track
}

const PAGE_SIZE = 50

/**
 * Single source of truth for the user's active playlist.
 *
 * HomeView renders from `entries`. SearchView pushes new tracks through
 * `add()` — the store owns the `addTrackToPlaylist` use-case + refresh,
 * so the Home list updates immediately without the views coordinating.
 *
 * Paginated: `refresh()` loads the first PAGE_SIZE entries and reports
 * the total. `loadMore()` appends the next page. `hasMore` drives the
 * Home view's IonInfiniteScroll.
 */
export const usePlaylistStore = defineStore("playlist", () => {
  const app = useShruti()

  const entries = ref<readonly PlaylistEntry[]>([])
  const total = ref<number>(0)
  // All track ids in the active playlist, regardless of whether their
  // rows have been paged into `entries` yet. Backs hasTrack() so Search
  // shows the "added" indicator even for tracks past the first page.
  const activeTrackIds = ref<ReadonlySet<string>>(new Set())
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loaded = false

  const hasMore = computed(() => entries.value.length < total.value)

  async function refresh(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const repos = app.repositories()
      const page = await listActivePlaylistTracks(
        { playlistItems: repos.playlistItems, tracks: repos.tracks },
        { limit: PAGE_SIZE, offset: 0 }
      )
      entries.value = page.entries
      total.value = page.total
      // hasTrack() needs the full active list, not just the first page.
      const allItems = await repos.playlistItems.listActive()
      activeTrackIds.value = new Set(allItems.map((i) => i.trackId))
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load playlist"
      entries.value = []
      total.value = 0
      activeTrackIds.value = new Set()
    } finally {
      isLoading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (!hasMore.value || isLoading.value) return
    try {
      const repos = app.repositories()
      const page = await listActivePlaylistTracks(
        { playlistItems: repos.playlistItems, tracks: repos.tracks },
        { limit: PAGE_SIZE, offset: entries.value.length }
      )
      entries.value = [...entries.value, ...page.entries]
      total.value = page.total
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load playlist"
    }
  }

  /**
   * Lazy refresh — only refetches if we've never loaded. Cheap to call
   * from every view's `onMounted`.
   */
  async function ensureLoaded(): Promise<void> {
    if (!loaded) await refresh()
  }

  async function add(trackId: TrackId): Promise<Result<PlaylistItem, AddTrackToPlaylistError>> {
    const repos = app.repositories()
    const result = await addTrackToPlaylist({ trackId }, { playlistItems: repos.playlistItems })
    if (result.ok) {
      await refresh()
      void prefetchAudio(trackId)
    }
    return result
  }

  // Fire-and-forget audio prefetch. The download indicator on the Home
  // row drives itself off the download store — the user sees progress
  // without the playlist view blocking on the network round-trip.
  async function prefetchAudio(trackId: TrackId): Promise<void> {
    try {
      const repos = app.repositories()
      const track = await repos.tracks.getById(trackId)
      const variant = track?.variants.find((v) => v.audio) ?? null
      if (!variant?.audio) return
      const remoteUrl = app.storagePublicUrl.get(variant.audio.path)
      useDownloadStore().prefetch(trackId, remoteUrl)
    } catch (err) {
      console.error("[playlist] prefetch failed", err)
    }
  }

  async function archive(
    itemId: PlaylistItemId
  ): Promise<Result<void, ArchivePlaylistItemError>> {
    const result = await archivePlaylistItem(
      { itemId },
      { playlistItems: app.repositories().playlistItems }
    )
    if (result.ok || result.error === "already-archived") await refresh()
    return result
  }

  async function archiveByTrackId(
    trackId: TrackId
  ): Promise<Result<void, ArchivePlaylistItemError> | null> {
    const target = entries.value.find((e) => e.item.trackId === trackId)
    if (!target) return null
    return archive(target.item.id)
  }

  function hasTrack(trackId: TrackId): boolean {
    return activeTrackIds.value.has(trackId)
  }

  return {
    entries,
    total,
    hasMore,
    isLoading,
    error,
    refresh,
    loadMore,
    ensureLoaded,
    add,
    archive,
    archiveByTrackId,
    hasTrack,
  }
})
