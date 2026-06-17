import type { PlaylistItemId } from "@lib/domain/core.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import { err, ok, type Result } from "@kit/core"

export interface ArchivePlaylistItemInput {
  readonly itemId: PlaylistItemId
}

export type ArchivePlaylistItemError = "not-found" | "already-archived"

export interface ArchivePlaylistItemDeps {
  readonly playlistItems: IPlaylistItemRepository
  readonly unitOfWork: IUnitOfWork
}

/**
 * Archive a playlist entry. Distinguishes the two "nothing to do" cases
 * so the UI can decide whether to toast or silently refresh the list.
 * The getById → archive check-then-act runs inside a transaction so a
 * concurrent writer can't slip an archive in between.
 */
export async function archivePlaylistItem(
  input: ArchivePlaylistItemInput,
  deps: ArchivePlaylistItemDeps
): Promise<Result<void, ArchivePlaylistItemError>> {
  return deps.unitOfWork.run(async () => {
    const existing = await deps.playlistItems.getById(input.itemId)
    if (!existing) return err("not-found")
    if (existing.archivedAt !== null) return err("already-archived")
    await deps.playlistItems.archive(input.itemId)
    return ok(undefined)
  })
}
