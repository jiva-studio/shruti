import type { IDatabase } from "@ports/app/index.js"
import type {
  ILibraryMembershipRepository,
  LibraryMembership,
} from "@lib/domain/ports/libraryMembershipRepository.js"
import type { LibraryMembershipRow } from "@lib/persistence/user"
import { mutate, queryMany, queryOne } from "@kit/persistence"

/**
 * SQL adapter for `library_memberships` — the user's remove/re-add intent for a
 * personal-library item (021 migration). `id` is the library item id (the sync
 * doc_id); a row exists only once the user acts, so absence means active. Writes
 * are upsert-only (a remove sets `archived_at`, a re-add clears it) — never a
 * delete — so the "absent = active" invariant holds. The sync-journal decorator
 * wraps `setArchived` / `setActive` to push the change; merged last-write-wins.
 */
export function createSqlLibraryMembershipRepository(db: IDatabase): ILibraryMembershipRepository {
  return {
    async listArchivedIds(): Promise<ReadonlySet<string>> {
      const ids = await queryMany<{ id: string }, string>(
        db,
        "SELECT id FROM library_memberships WHERE archived_at IS NOT NULL",
        [],
        (r) => r.id
      )
      return new Set(ids)
    },

    async getById(id: string): Promise<LibraryMembership | null> {
      return queryOne<LibraryMembershipRow, LibraryMembership>(
        db,
        "SELECT id, archived_at, updated_at FROM library_memberships WHERE id = ?",
        [id],
        (r) => ({ id: r.id, archivedAt: r.archived_at })
      )
    },

    async setArchived(id: string): Promise<void> {
      const now = Date.now()
      await mutate(
        db,
        `INSERT INTO library_memberships (id, archived_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET archived_at = excluded.archived_at, updated_at = excluded.updated_at`,
        [id, now, now]
      )
    },

    async setActive(id: string): Promise<void> {
      await mutate(
        db,
        `INSERT INTO library_memberships (id, archived_at, updated_at) VALUES (?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET archived_at = NULL, updated_at = excluded.updated_at`,
        [id, Date.now()]
      )
    },

    async clearAll(): Promise<void> {
      await mutate(db, "DELETE FROM library_memberships")
    },
  }
}
