import type { IDatabase } from "@ports/app/index.js"
import { hlcNow, hlcToString, parseHlc, type SyncOp } from "@lib/domain"

export interface JournalWriter {
  /** Append one outbox row. Runs inside the caller's transaction. */
  append: (collection: string, docId: string, op: SyncOp, data: unknown | null) => Promise<void>
  /** True once `(collection, doc_id)` has a pending outbox row or a recorded
   *  server HLC — i.e. the document has entered sync at least once. */
  wasJournaled: (collection: string, docId: string) => Promise<boolean>
}

export interface JournalWriterDeps {
  readonly userDb: IDatabase
  readonly getDeviceId: () => Promise<string>
  readonly getOwnerId?: () => string | null
}

/**
 * The outbox side of journaling: stamping a change with the next HLC and
 * writing the row.
 *
 * The stamp is taken from the highest clock this device has issued OR
 * observed. The outbox tail alone is only what it issued; a remote stamp
 * already pulled in is just as much part of the clock, and skipping it lets a
 * device whose wall clock trails another's stamp an edit BELOW the change that
 * edit descends from. The server accepts the push — it gates on `base_hlc`,
 * not on ordering — and every device that pulls both then resolves LWW in
 * favour of the older text.
 */
export function createJournalWriter(deps: JournalWriterDeps): JournalWriter {
  const { userDb } = deps

  async function nextHlc(): Promise<string> {
    // Plain MAX over the union: `hlcToString` zero-pads both numeric
    // components, so SQLite's lexicographic order is `compareHlc`'s order.
    const rows = await userDb.query<{ hlc: string | null }>(
      `SELECT MAX(hlc) AS hlc FROM (
         SELECT (SELECT hlc FROM outbox ORDER BY id DESC LIMIT 1) AS hlc
         UNION ALL
         SELECT (SELECT MAX(server_hlc) FROM sync_doc_hlc)
       )`
    )
    const seed = rows[0]?.hlc ?? null
    return hlcToString(hlcNow(await deps.getDeviceId(), seed === null ? null : parseHlc(seed)))
  }

  return {
    async append(collection, docId, op, data) {
      await userDb.execute(
        `INSERT INTO outbox
           (collection, doc_id, op, data, hlc, base_hlc, created_at, sent, owner_id)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 0, ?)`,
        [
          collection,
          docId,
          op,
          data === null ? null : JSON.stringify(data),
          await nextHlc(),
          Date.now(),
          deps.getOwnerId?.() ?? null,
        ]
      )
    },

    async wasJournaled(collection, docId) {
      const pending = await userDb.query<{ one: number }>(
        "SELECT 1 AS one FROM outbox WHERE collection = ? AND doc_id = ? LIMIT 1",
        [collection, docId]
      )
      if (pending.length > 0) return true
      const recorded = await userDb.query<{ one: number }>(
        "SELECT 1 AS one FROM sync_doc_hlc WHERE collection = ? AND doc_id = ? LIMIT 1",
        [collection, docId]
      )
      return recorded.length > 0
    },
  }
}
