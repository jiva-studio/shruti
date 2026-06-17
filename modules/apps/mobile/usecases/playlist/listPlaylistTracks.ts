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

export interface ListActivePlaylistTracksInput {
  /** Slice `listActive()` before hydrating tracks. Omit for the full list. */
  readonly limit?: number
  readonly offset?: number
}

export interface ActivePlaylistPage {
  readonly entries: readonly PlaylistEntry[]
  /** Total number of active playlist items before slicing (for pagination). */
  readonly total: number
}

/**
 * Joins active playlist items with their domain tracks. Items whose track
 * has disappeared from the content DB (e.g. after a catalogue update) are
 * filtered out — they're not a programmer error, just a stale pointer.
 * The discrepancy is visible to the caller as `entries.length < total`.
 *
 * Track hydration is done in parallel (`Promise.all`) — previously this
 * was a sequential loop, which dominated Home's time-to-first-paint on
 * large playlists.
 */
export async function listActivePlaylistTracks(
  deps: ListPlaylistTracksDeps,
  input: ListActivePlaylistTracksInput = {}
): Promise<ActivePlaylistPage> {
  const items = await deps.playlistItems.listActive()
  const { limit, offset = 0 } = input
  const page = limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit)
  const tracks = await Promise.all(page.map((item) => deps.tracks.getById(item.trackId)))
  const entries: PlaylistEntry[] = []
  for (let i = 0; i < page.length; i++) {
    const track = tracks[i]
    if (track) entries.push({ item: page[i], track })
  }
  return { entries, total: items.length }
}
