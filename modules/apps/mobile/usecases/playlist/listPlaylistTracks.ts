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
 * Track hydration is a single batched `getByIds()` read — previously this
 * fanned out one `getById()` per item (≈6 bridge round-trips each), which
 * dominated Home's time-to-first-paint on large playlists.
 */
export async function listActivePlaylistTracks(
  deps: ListPlaylistTracksDeps,
  input: ListActivePlaylistTracksInput = {}
): Promise<ActivePlaylistPage> {
  const items = await deps.playlistItems.listActive()
  const { limit, offset = 0 } = input
  const page = limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit)
  const tracksById = await deps.tracks.getByIds(page.map((item) => item.trackId))
  const entries: PlaylistEntry[] = []
  for (const item of page) {
    const track = tracksById.get(item.trackId)
    if (track) entries.push({ item, track })
  }
  return { entries, total: items.length }
}
