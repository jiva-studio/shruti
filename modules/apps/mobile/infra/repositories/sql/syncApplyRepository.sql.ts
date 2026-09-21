import type { IDatabase } from "@ports/app/index.js"
import type { ISyncApplyRepository } from "@lib/domain/ports/syncApplyRepository.js"
import type { SyncDoc } from "@lib/domain"
import { maxHlcString } from "@lib/domain"
import type { SyncDocHlcRow } from "@lib/persistence/user"
import { lookupCollection, type CollectionTables } from "./syncCollections.js"
import { CHAT_TABLES } from "./syncTablesChat.js"
import { LIBRARY_TABLES } from "./syncTablesLibrary.js"
import { USER_CONTENT_TABLES } from "./syncTablesUserContent.js"

/**
 * SQL adapter implementing {@link ISyncApplyRepository}: applies **remote**
 * changes to the synced collection tables and maintains the `sync_doc_hlc`
 * side-table.
 *
 * Deliberately bypasses the domain repositories so a pulled change is **not**
 * re-journaled into the outbox, which would echo it back to the server. Every
 * write is raw SQL inside the caller's reentrant unit of work; each
 * collection's read, write and tombstone live together in its own
 * {@link CollectionTable}.
 */
const TABLES: CollectionTables = {
  ...USER_CONTENT_TABLES,
  ...CHAT_TABLES,
  ...LIBRARY_TABLES,
}

/** Lowest possible HLC — used as the local doc's HLC when none is on record
 *  (a pre-sync row) so a remote change with any real HLC wins on the LWW
 *  collections, while the add-wins playlist rule still unions the fields. */
const FLOOR_HLC = "000000000000000:00000:0"

/** Chunk size for the `IN (...)` deletes, under SQLite's 999-variable cap. */
const FORGET_CHUNK = 400

export function createSqlSyncApplyRepository(db: IDatabase): ISyncApplyRepository {
  /** Highest of the pending-outbox HLC and the recorded server HLC for a doc,
   *  or null when neither exists. */
  async function knownLocalHlc(collection: string, docId: string): Promise<string | null> {
    const outboxRows = await db.query<{ hlc: string }>(
      "SELECT hlc FROM outbox WHERE collection = ? AND doc_id = ? ORDER BY id DESC LIMIT 1",
      [collection, docId]
    )
    const serverRows = await db.query<Pick<SyncDocHlcRow, "server_hlc">>(
      "SELECT server_hlc FROM sync_doc_hlc WHERE collection = ? AND doc_id = ?",
      [collection, docId]
    )
    return maxHlcString(outboxRows[0]?.hlc ?? null, serverRows[0]?.server_hlc ?? null)
  }

  async function recordServerHlc(collection: string, docId: string, hlc: string): Promise<void> {
    await db.execute(
      `INSERT INTO sync_doc_hlc (collection, doc_id, server_hlc) VALUES (?, ?, ?)
       ON CONFLICT(collection, doc_id) DO UPDATE SET server_hlc = ?`,
      [collection, docId, hlc, hlc]
    )
  }

  return {
    async getLocalDoc(collection: string, docId: string): Promise<SyncDoc<unknown> | null> {
      const localHlc = await knownLocalHlc(collection, docId)
      const row = await lookupCollection(TABLES, collection).read(db, docId)
      if (row === null && localHlc === null) return null
      return { docId, hlc: localHlc ?? FLOOR_HLC, deleted: row === null, data: row }
    },

    async applyRemote(collection: string, doc: SyncDoc<unknown>, serverHlc: string): Promise<void> {
      const table = lookupCollection(TABLES, collection)
      if (doc.deleted || doc.data === null) await table.remove(db, doc.docId)
      else await table.upsert(db, doc.docId, doc.data)
      await recordServerHlc(collection, doc.docId, serverHlc)
    },

    lastServerHlc: async (collection, docId) => {
      const rows = await db.query<Pick<SyncDocHlcRow, "server_hlc">>(
        "SELECT server_hlc FROM sync_doc_hlc WHERE collection = ? AND doc_id = ?",
        [collection, docId]
      )
      return rows[0]?.server_hlc ?? null
    },

    latestServerHlc: async () => {
      // Plain MAX: `hlcToString` zero-pads both numeric components, so SQLite's
      // lexicographic ordering is the same total order as `compareHlc`.
      const rows = await db.query<{ hlc: string | null }>(
        "SELECT MAX(server_hlc) AS hlc FROM sync_doc_hlc"
      )
      return rows[0]?.hlc ?? null
    },

    recordServerHlc,

    forgetDocHlcs: async (refs) => {
      for (let i = 0; i < refs.length; i += FORGET_CHUNK) {
        const slice = refs.slice(i, i + FORGET_CHUNK)
        const placeholders = slice.map(() => "(?, ?)").join(",")
        await db.execute(
          `DELETE FROM sync_doc_hlc WHERE (collection, doc_id) IN (${placeholders})`,
          slice.flatMap((r) => [r.collection, r.docId])
        )
      }
    },

    clearDocHlcs: async () => {
      await db.execute("DELETE FROM sync_doc_hlc")
    },
  }
}
