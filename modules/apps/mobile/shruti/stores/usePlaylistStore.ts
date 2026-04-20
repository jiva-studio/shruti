import { defineStore } from "pinia"
import { ref } from "vue"
import { addTrackToPlaylist, type AddTrackToPlaylistError } from "@lib/application/addTrackToPlaylist.js"
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

/**
 * Single source of truth for the user's active playlist.
 *
 * HomeView renders from `entries`. SearchView pushes new tracks through
 * `add()` — the store owns the `addTrackToPlaylist` use-case + refresh,
 * so the Home list updates immediately without the views coordinating.
 */
export const usePlaylistStore = defineStore("playlist", () => {
  const app = useShruti()

  const entries = ref<readonly PlaylistEntry[]>([])
  const isLoading = ref<boolean>(false)
  const error = ref<string | null>(null)
  let loaded = false

  async function refresh(): Promise<void> {
    isLoading.value = true
    error.value = null
    try {
      const repos = app.repositories()
      entries.value = await listActivePlaylistTracks({
        playlistItems: repos.playlistItems,
        tracks: repos.tracks,
      })
      loaded = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Failed to load playlist"
      entries.value = []
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Lazy refresh — only refetches if we've never loaded. Cheap to call
   * from every view's `onMounted`.
   */
  async function ensureLoaded(): Promise<void> {
    if (!loaded) await refresh()
  }

  async function add(
    trackId: TrackId
  ): Promise<Result<PlaylistItem, AddTrackToPlaylistError>> {
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

  async function archive(itemId: PlaylistItemId): Promise<void> {
    await app.repositories().playlistItems.archive(itemId)
    await refresh()
  }

  async function archiveByTrackId(trackId: TrackId): Promise<void> {
    const target = entries.value.find((e) => e.item.trackId === trackId)
    if (!target) return
    await archive(target.item.id)
  }

  function hasTrack(trackId: TrackId): boolean {
    return entries.value.some((e) => e.item.trackId === trackId)
  }

  return {
    entries,
    isLoading,
    error,
    refresh,
    ensureLoaded,
    add,
    archive,
    archiveByTrackId,
    hasTrack,
  }
})
