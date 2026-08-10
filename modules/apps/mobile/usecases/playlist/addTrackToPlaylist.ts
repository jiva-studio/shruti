import type { TrackId } from "@lib/domain/core.js"
import type { PlaylistItem } from "@lib/domain/playlistItem.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { err, ok, type Result } from "@kit/core"

export interface AddTrackToPlaylistInput {
  readonly trackId: TrackId
  /** Source collection when the track is added as part of an "add all". */
  readonly collectionId?: string | null
}

export type AddTrackToPlaylistError = "already-in-playlist" | "write-failed"

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
  try {
    return await deps.unitOfWork.run(async (tx) => {
      const active = await deps.playlistItems.listActive()
      const existing = active.find((item) => item.trackId === input.trackId)
      if (existing) return err("already-in-playlist")
      // The handle keeps the insert and its journal entry in THIS transaction.
      const created = await deps.playlistItems.add(input.trackId, input.collectionId ?? null, tx)
      return ok(created)
    })
  } catch {
    // DB write failed (disk full, contended) — honour the Result contract
    // instead of throwing out of a usecase the caller awaits as a Result.
    return err("write-failed")
  }
}
