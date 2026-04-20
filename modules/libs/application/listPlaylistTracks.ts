import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { Track } from "@lib/domain/track.js"

export interface PlaylistEntry {
  readonly item: PlaylistItem
  readonly track: Track
}

export interface ListPlaylistTracksDeps {
  readonly playlistItems: IPlaylistItemRepository
  readonly tracks: ITrackRepository
}

/**
 * Joins active playlist items with their domain tracks. Items whose track
 * has disappeared from the content DB (e.g. after a catalogue update) are
 * filtered out — they're not a programmer error, just a stale pointer.
 */
export async function listActivePlaylistTracks(
  deps: ListPlaylistTracksDeps
): Promise<readonly PlaylistEntry[]> {
  const items = await deps.playlistItems.listActive()
  const entries: PlaylistEntry[] = []
  for (const item of items) {
    const track = await deps.tracks.getById(item.trackId)
    if (track) entries.push({ item, track })
  }
  return entries
}
