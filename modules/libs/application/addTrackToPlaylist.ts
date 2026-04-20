import type { TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export interface AddTrackToPlaylistInput {
  readonly trackId: TrackId
}

export type AddTrackToPlaylistError = "already-in-playlist"

export interface AddTrackToPlaylistDeps {
  readonly playlistItems: IPlaylistItemRepository
}

/**
 * Idempotently add a track to the active playlist. If the track is
 * already there (active — not archived), we return `already-in-playlist`
 * so the UI can surface a "already added" toast instead of silently
 * doing nothing or creating a duplicate entry.
 */
export async function addTrackToPlaylist(
  input: AddTrackToPlaylistInput,
  deps: AddTrackToPlaylistDeps
): Promise<Result<PlaylistItem, AddTrackToPlaylistError>> {
  const active = await deps.playlistItems.listActive()
  const existing = active.find((item) => item.trackId === input.trackId)
  if (existing) return err("already-in-playlist")
  const created = await deps.playlistItems.add(input.trackId)
  return ok(created)
}
