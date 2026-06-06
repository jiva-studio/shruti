import type { TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { err, ok, type Result } from "@kit/core"

export interface AddTrackToPlaylistInput {
  readonly trackId: TrackId
}

export type AddTrackToPlaylistError = "already-in-playlist"

export interface AddTrackToPlaylistDeps {
  readonly playlistItems: IPlaylistItemRepository
  readonly unitOfWork: IUnitOfWork
}

/**
 * Idempotently add a track to the active playlist. If the track is
 * already there (active — not archived), we return `already-in-playlist`
 * so the UI can surface a "already added" toast instead of silently
 * doing nothing or creating a duplicate entry.
 *
 * The check and the insert run inside one unit-of-work so that two
 * concurrent callers (fast double-tap on the Add button) can't both
 * pass the duplicate check and end up with two active rows.
 */
export async function addTrackToPlaylist(
  input: AddTrackToPlaylistInput,
  deps: AddTrackToPlaylistDeps
): Promise<Result<PlaylistItem, AddTrackToPlaylistError>> {
  return deps.unitOfWork.run(async () => {
    const active = await deps.playlistItems.listActive()
    const existing = active.find((item) => item.trackId === input.trackId)
    if (existing) return err("already-in-playlist")
    const created = await deps.playlistItems.add(input.trackId)
    return ok(created)
  })
}
