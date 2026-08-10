import type { ITransaction } from "./unitOfWork.js"

/**
 * Personal-library membership repository — the user's remove/re-add intent for a
 * library item, CLIENT-owned and synced (pushed + merged last-write-wins). A row
 * exists only once the user has acted on the item; ABSENCE means active (in the
 * library). `id` is the library item id (= `library_items.id`, the sync doc_id).
 *
 * The client only ever upserts — a remove sets `archivedAt`, a re-add clears it —
 * never deletes, so "no row" and `archivedAt === null` both mean active.
 */
export interface LibraryMembership {
  readonly id: string
  /** Unix ms when removed; `null` when active (re-added). */
  readonly archivedAt: number | null
}

export interface ILibraryMembershipRepository {
  /* `tx` on the mutating methods: the caller's open transaction handle (see
   * {@link ITransaction}). */
  /** Ids of items the user has REMOVED (an archived membership). Absence from
   *  the set = active by default. Drives the "hide removed" join in the store. */
  listArchivedIds(): Promise<ReadonlySet<string>>
  getById(id: string): Promise<LibraryMembership | null>
  /** Remove from the library: upsert `archived_at = now`. */
  setArchived(id: string, tx?: ITransaction): Promise<void>
  /** Re-add to the library: upsert `archived_at = NULL`. */
  setActive(id: string, tx?: ITransaction): Promise<void>
  clearAll(): Promise<void>
}
