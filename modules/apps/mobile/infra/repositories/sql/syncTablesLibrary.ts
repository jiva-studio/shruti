import type { QueryValue } from "@ports/app/index.js"
import type { LibraryItemRow, LibraryMembershipRow } from "@lib/persistence/user"
import type { CollectionTable, CollectionTables } from "./syncCollections.js"
import {
  libraryItemRowToWire,
  libraryMembershipRowToWire,
  type LibraryItemWire,
  type LibraryMembershipWire,
} from "./syncWire.js"

/** Every scalar column but `id`, in the order the insert below lists them. */
const LIBRARY_ITEM_SCALARS = [
  "track_id",
  "status",
  "origin",
  "title_raw",
  "author_raw",
  "location_raw",
  "date_raw",
  "lang_hint",
  "author_id",
  "location_id",
  "date",
  "lang",
  "error",
  "audio_key",
  "transcript_key",
  "duration",
  "cover_key",
] as const

const LIBRARY_ITEM_COLUMNS = [
  "id",
  ...LIBRARY_ITEM_SCALARS,
  "references_json",
  "variants_json",
  "source_url",
  "created_at",
  "updated_at",
]

const jsonOrNull = (list: readonly unknown[] | null | undefined): string | null =>
  list?.length ? JSON.stringify(list) : null

function libraryItemParams(docId: string, wire: LibraryItemWire): QueryValue[] {
  return [
    docId,
    ...LIBRARY_ITEM_SCALARS.map((column) => wire[column] ?? null),
    jsonOrNull(wire.references),
    jsonOrNull(wire.variants),
    wire.source_url ?? null,
    wire.created_at ?? null,
    wire.updated_at ?? null,
  ]
}

// Pull-only and server-owned: the server is the single writer, so the row is
// applied wholesale keyed on the sync doc_id (= membership id). `INSERT OR
// REPLACE` is fine — nothing references library_items by FK.
const libraryItems: CollectionTable = {
  async read(db, docId) {
    const rows = await db.query<LibraryItemRow>("SELECT * FROM library_items WHERE id = ?", [docId])
    return rows[0] ? libraryItemRowToWire(rows[0]) : null
  },
  async upsert(db, docId, data) {
    const slots = LIBRARY_ITEM_COLUMNS.map(() => "?").join(", ")
    await db.execute(
      `INSERT OR REPLACE INTO library_items (${LIBRARY_ITEM_COLUMNS.join(", ")})
       VALUES (${slots})`,
      libraryItemParams(docId, data as LibraryItemWire)
    )
  },
  async remove(db, docId) {
    // A server-authored removal ("remove from My library") arrives as a
    // tombstone; drop the local row.
    await db.execute("DELETE FROM library_items WHERE id = ?", [docId])
  },
}

// Client-owned toggle applied wholesale, keyed on the sync doc_id (= library
// item id). archived_at NULL = active, set = removed.
const libraryMemberships: CollectionTable = {
  async read(db, docId) {
    const rows = await db.query<LibraryMembershipRow>(
      "SELECT id, archived_at, updated_at FROM library_memberships WHERE id = ?",
      [docId]
    )
    return rows[0] ? libraryMembershipRowToWire(rows[0]) : null
  },
  async upsert(db, docId, data) {
    const wire = data as LibraryMembershipWire
    await db.execute(
      `INSERT INTO library_memberships (id, archived_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         archived_at = excluded.archived_at,
         updated_at = excluded.updated_at`,
      [docId, wire.archived_at ?? null, wire.updated_at ?? null]
    )
  },
  async remove(db, docId) {
    // The client never emits a membership tombstone (remove and re-add are
    // both upserts), but a delete would revert to the active default — so the
    // row goes.
    await db.execute("DELETE FROM library_memberships WHERE id = ?", [docId])
  },
}

export const LIBRARY_TABLES: CollectionTables = {
  library_items: libraryItems,
  library_memberships: libraryMemberships,
}
