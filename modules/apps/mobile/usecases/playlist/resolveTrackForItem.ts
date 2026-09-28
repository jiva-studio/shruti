import type { PlaylistItemId } from "@lib/domain/core.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { Track } from "@lib/domain/track.js"
import { trackIdFromSyntheticItemId } from "../playback/playTrack.js"

/**
 * The track behind a playback item id that the active list no longer holds:
 * an item archived while it was still queued, or the synthetic `track:<id>` a
 * screen outside the playlist plays under. The native queue outlives the list,
 * so this has to survive the item leaving it. A failed read is an unknown
 * track, not an error.
 */
export async function resolveTrackForItem(
  itemId: PlaylistItemId,
  deps: { readonly playlistItems: IPlaylistItemRepository; readonly tracks: ITrackRepository }
): Promise<Track | undefined> {
  const item = await deps.playlistItems.getById(itemId).catch(() => null)
  const trackId = item?.trackId ?? trackIdFromSyntheticItemId(itemId)
  if (!trackId) return undefined
  return (await deps.tracks.getById(trackId).catch(() => null)) ?? undefined
}
