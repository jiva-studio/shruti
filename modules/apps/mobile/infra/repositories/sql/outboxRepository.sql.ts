import type { IDatabase } from "@ports/app/index.js"
import type {
  IOutboxRepository,
  OutboxEntry,
  OutboxScope,
  OutboxPrune,
  OutboxReattribution,
  NewOutboxEntry,
} from "@lib/domain/ports/outboxRepository.js"
import type { SyncDocRef, SyncOp } from "@lib/domain"
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

    async prune(scope: OutboxPrune): Promise<void> {
      if (scope.watermark <= 0 || scope.docs.length === 0) return
      // Chunked like `forgetDocHlcs`: two placeholders per document, under
      // SQLite's 999-variable cap.
      const CHUNK = 400
      for (let i = 0; i < scope.docs.length; i += CHUNK) {
        const slice = scope.docs.slice(i, i + CHUNK)
        const pairs = slice.map(() => "(?, ?)").join(",")
        const params: (string | number)[] = [scope.watermark]
        for (const ref of slice) params.push(ref.collection, ref.docId)
        // The `EXISTS` is the "superseded" test and the only thing standing
        // between compaction and a broken handover (see the port). It reads as
        // a self-join but costs an `idx_outbox_collection_doc` (024) seek per
        // candidate row, and it is what keeps the newest row of every
        // document — the journal's tail included, which nothing supersedes.
        await db.execute(
          `DELETE FROM outbox
            WHERE sent = 1
              AND id < ?
              AND (collection, doc_id) IN (${pairs})
              AND EXISTS (SELECT 1 FROM outbox newer
                           WHERE newer.collection = outbox.collection
                             AND newer.doc_id = outbox.doc_id
                             AND newer.id > outbox.id)`,
          params
        )
      }
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
          // An explicit owner wins: the caller knows whose row this is, the
          // provider only knows who is here now.
          entry.ownerId !== undefined ? entry.ownerId : (getOwnerId?.() ?? null),
        ]
      )
    },

    async reattribute(scope: OutboxReattribution): Promise<readonly SyncDocRef[]> {
      if (scope.fromOwnerId === scope.toOwnerId) return []
      const where = "(owner_id = ? OR (owner_id IS NULL AND id > ?))"
      const params = [scope.fromOwnerId, scope.unownedAfterId]
      const refs = await db.query<{ collection: string; doc_id: string }>(
        `SELECT DISTINCT collection, doc_id FROM outbox WHERE ${where}`,
        params
      )
      if (refs.length === 0) return []
      // `sent = 0` is what re-opens the already-uploaded history: those rows
      // reached the anonymous account only, so the new owner has to see them
      // as pending again. `base_hlc = ''` states they descend from nothing the
      // new account has — see the push's reading of it.
      await db.execute(`UPDATE outbox SET owner_id = ?, sent = 0, base_hlc = '' WHERE ${where}`, [
        scope.toOwnerId,
        ...params,
      ])
      return refs.map((r) => ({ collection: r.collection, docId: r.doc_id }))
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

    async clearAll(): Promise<void> {
      await db.execute("DELETE FROM outbox")
    },
  }
}
