import type { LibraryItem } from "@lib/domain/libraryItem.js"
import type { ILibraryItemRepository } from "@lib/domain/ports/libraryItemRepository.js"
import type { ILibraryMembershipRepository } from "@lib/domain/ports/libraryMembershipRepository.js"

export interface LibraryShelfDeps {
  readonly libraryItems: ILibraryItemRepository
  readonly libraryMemberships: ILibraryMembershipRepository
}

export interface LibraryShelf {
  /** Every ingest fact, removed items included. */
  readonly items: readonly LibraryItem[]
  /** The items the user removed; absent membership means active. */
  readonly archivedIds: ReadonlySet<string>
}

/**
 * The personal library as two collections: the server-owned ingest facts and
 * the client-owned remove/re-add intent. The visible shelf is their join.
 */
export async function loadLibraryShelf(deps: LibraryShelfDeps): Promise<LibraryShelf> {
  const [items, archivedIds] = await Promise.all([
    deps.libraryItems.listAll(),
    deps.libraryMemberships.listArchivedIds(),
  ])
  return { items, archivedIds }
}

/**
 * A client-owned soft delete: archive the membership, which syncs across the
 * user's devices. The facts and the stored content stay, so a re-add is
 * instant with no re-ingest.
 */
export async function removeFromLibrary(
  id: string,
  deps: Pick<LibraryShelfDeps, "libraryMemberships">
): Promise<void> {
  await deps.libraryMemberships.setArchived(id)
}

/** Bring a removed item back onto the shelf. */
export async function restoreToLibrary(
  id: string,
  deps: Pick<LibraryShelfDeps, "libraryMemberships">
): Promise<void> {
  await deps.libraryMemberships.setActive(id)
}
