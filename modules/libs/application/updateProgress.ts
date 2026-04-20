import type { PlaylistItemId } from "@lib/domain/core.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export interface UpdateProgressInput {
  readonly itemId: PlaylistItemId
  /** Playback position in milliseconds. Negative values are rejected. */
  readonly progressMs: number
}

export type UpdateProgressError = "not-found" | "invalid-progress"

export interface UpdateProgressDeps {
  readonly playlistItems: IPlaylistItemRepository
}

/**
 * Persist playback position for a playlist item. Used by the player
 * store on seek and during playback tick-down.
 */
export async function updateProgress(
  input: UpdateProgressInput,
  deps: UpdateProgressDeps
): Promise<Result<void, UpdateProgressError>> {
  if (!Number.isFinite(input.progressMs) || input.progressMs < 0) {
    return err("invalid-progress")
  }
  const existing = await deps.playlistItems.getById(input.itemId)
  if (!existing) return err("not-found")
  await deps.playlistItems.updateProgress(input.itemId, input.progressMs)
  return ok(undefined)
}
