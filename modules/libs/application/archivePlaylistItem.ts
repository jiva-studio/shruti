import type { PlaylistItemId } from "@lib/domain/core.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import { err, ok, type Result } from "@lib/domain/result.js"

export interface ArchivePlaylistItemInput {
  readonly itemId: PlaylistItemId
}

export type ArchivePlaylistItemError = "not-found" | "already-archived"

export interface ArchivePlaylistItemDeps {
  readonly playlistItems: IPlaylistItemRepository
}

/**
 * Archive a playlist entry. Distinguishes the two "nothing to do" cases
 * so the UI can decide whether to toast or silently refresh the list.
 */
export async function archivePlaylistItem(
  input: ArchivePlaylistItemInput,
  deps: ArchivePlaylistItemDeps
): Promise<Result<void, ArchivePlaylistItemError>> {
  const existing = await deps.playlistItems.getById(input.itemId)
  if (!existing) return err("not-found")
  if (existing.archivedAt !== null) return err("already-archived")
  await deps.playlistItems.archive(input.itemId)
  return ok(undefined)
}
