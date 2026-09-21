import type { Ref } from "vue"
import { trackIdFromSyntheticItemId } from "@usecases/playback/playTrack.js"
import type { PlaylistEntry } from "@usecases/playlist/listPlaylistTracks.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import { useShruti } from "@shruti/shruti.js"

export interface PlaylistLookupsReturn {
  /**
   * First entry whose track matches the given id. Searches the whole active
   * playlist — a lecture opened from the Track screen or a chat citation must
   * resolve to its playlist item however deep it sits, otherwise playback is
   * journaled under a synthetic id no row carries.
   */
  getEntryByTrackId(trackId: TrackId): PlaylistEntry | undefined
  /** Entry for a playlist item id. Not bounded by the rendered page. */
  getEntryByItemId(itemId: PlaylistItemId): PlaylistEntry | undefined
  /**
   * The track behind a playback item id, wherever the id came from: the active
   * list, an item archived while it was still queued, or the synthetic
   * `track:<id>` a screen outside the playlist plays under. The native queue
   * outlives the list the store holds, so this has to survive the item leaving
   * it.
   */
  resolveTrackForItemId(itemId: PlaylistItemId): Promise<Track | undefined>
}

export function usePlaylistLookups(
  activeEntries: Ref<readonly PlaylistEntry[]>
): PlaylistLookupsReturn {
  const app = useShruti()

  function getEntryByTrackId(trackId: TrackId): PlaylistEntry | undefined {
    return activeEntries.value.find((e) => e.item.trackId === trackId)
  }

  function getEntryByItemId(itemId: PlaylistItemId): PlaylistEntry | undefined {
    return activeEntries.value.find((e) => e.item.id === itemId)
  }

  async function resolveTrackForItemId(itemId: PlaylistItemId): Promise<Track | undefined> {
    const entry = getEntryByItemId(itemId)
    if (entry) return entry.track
    const repos = app.repositories()
    const item = await repos.playlistItems.getById(itemId).catch(() => null)
    const trackId = item?.trackId ?? trackIdFromSyntheticItemId(itemId)
    if (!trackId) return undefined
    return (await repos.tracks.getById(trackId).catch(() => null)) ?? undefined
  }

  return { getEntryByTrackId, getEntryByItemId, resolveTrackForItemId }
}
