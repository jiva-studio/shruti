import type { IDatabase } from "@ports/app/index.js"
import type {
  IOutboxRepository,
  OutboxEntry,
  OutboxScope,
  NewOutboxEntry,
} from "@lib/domain/ports/outboxRepository.js"
import type { SyncOp } from "@lib/domain"
import type { OutboxRow } from "@lib/persistence/user"

/**
 * SQL adapter over the local `outbox` journal (013 migration) implementing
 * {@link IOutboxRepository} — the push-side view of the sync engine.
 *
 * Writes use raw `db.execute` (not `mutate`, which would `save()` mid-way):
 * the engine wraps every mutation in the shared reentrant unit-of-work, so the
 * one enclosing transaction commits and persists once. Never opens its own
 * transaction.
 *
 * `getOwnerId` resolves the account journaling right now (023 migration); it
 * is read per append, not captured, because the identity changes under a live
 * repository bundle. Omitted ⇒ rows are written unowned, which leaves them to
 * the watermark exactly as they were before the column existed.
 */
export function createSqlOutboxRepository(
  db: IDatabase,
  getOwnerId?: () => string | null
): IOutboxRepository {
  function toEntry(row: OutboxRow): OutboxEntry {
    return {
      id: row.id,
      collection: row.collection,
      docId: row.doc_id,
      op: row.op as SyncOp,
      data: row.data === null ? null : (JSON.parse(row.data) as unknown),
      hlc: row.hlc,
      baseHlc: row.base_hlc,
    }
  }

  return {
    async listPending(limit?: number, scope?: OutboxScope): Promise<readonly OutboxEntry[]> {
      // `owner_id = NULL` is never true, so an absent ownerId degrades to the
      // watermark-only rule the unowned rows already follow.
      const sql = `SELECT * FROM outbox
                    WHERE sent = 0 AND (owner_id = ? OR (owner_id IS NULL AND id > ?))
                    ORDER BY id ASC`
      const params = [scope?.ownerId ?? null, scope?.afterId ?? 0]
      const rows =
        limit === undefined
          ? await db.query<OutboxRow>(sql, params)
          : await db.query<OutboxRow>(`${sql} LIMIT ?`, [...params, limit])
      return rows.map(toEntry)
    },

    async markSent(ids: readonly number[]): Promise<void> {
      if (ids.length === 0) return
      const placeholders = ids.map(() => "?").join(",")
      await db.execute(`UPDATE outbox SET sent = 1 WHERE id IN (${placeholders})`, [...ids])
    },

    async append(entry: NewOutboxEntry): Promise<void> {
      await db.execute(
        `INSERT INTO outbox
           (collection, doc_id, op, data, hlc, base_hlc, created_at, sent, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [
          entry.collection,
          entry.docId,
          entry.op,
          entry.data === null ? null : JSON.stringify(entry.data),
          entry.hlc,
          entry.baseHlc,
          Date.now(),
          getOwnerId?.() ?? null,
        ]
      )
    },

    async latestHlc(): Promise<string | null> {
      const rows = await db.query<{ hlc: string }>(
        "SELECT hlc FROM outbox ORDER BY id DESC LIMIT 1"
      )
      return rows.length > 0 ? rows[0]!.hlc : null
    },

    async latestId(): Promise<number> {
      const rows = await db.query<{ id: number }>("SELECT id FROM outbox ORDER BY id DESC LIMIT 1")
      return rows.length > 0 ? Number(rows[0]!.id) : 0
    },
  }
}
