import type { IDatabase } from "@ports/app/index.js"

/**
 * One synced collection's three operations against its local table, in the
 * client-native (snake_case) wire shape the journal decorator also writes.
 *
 * Read, write and tombstone sit together per collection: they share the row's
 * identity rule, and a key that differs between them silently resurrects or
 * loses rows.
 */
export interface CollectionTable {
  /** The local row as wire, or null when the device does not carry it. */
  read(db: IDatabase, docId: string): Promise<unknown | null>
  upsert(db: IDatabase, docId: string, data: unknown): Promise<void>
  remove(db: IDatabase, docId: string): Promise<void>
}

export type CollectionTables = Readonly<Record<string, CollectionTable>>

export function lookupCollection(tables: CollectionTables, collection: string): CollectionTable {
  const table = tables[collection]
  if (!table) throw new Error(`syncApply: unknown collection "${collection}"`)
  return table
}
