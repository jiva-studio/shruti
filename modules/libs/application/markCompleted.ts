import type { PlaylistItemId } from "@lib/domain/core.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export interface MarkCompletedInput {
  readonly itemId: PlaylistItemId
}

export type MarkCompletedError = "not-found" | "already-completed"

export interface MarkCompletedDeps {
  readonly playlistItems: IPlaylistItemRepository
}

/**
 * Mark a playlist entry as finished. Idempotent from the caller's view —
 * calling again returns `already-completed` so the UI can decide whether
 * to show a subtle "already finished" cue instead of firing a celebration.
 */
export async function markCompleted(
  input: MarkCompletedInput,
  deps: MarkCompletedDeps
): Promise<Result<void, MarkCompletedError>> {
  const existing = await deps.playlistItems.getById(input.itemId)
  if (!existing) return err("not-found")
  if (existing.completedAt !== null) return err("already-completed")
  await deps.playlistItems.markCompleted(input.itemId)
  return ok(undefined)
}
