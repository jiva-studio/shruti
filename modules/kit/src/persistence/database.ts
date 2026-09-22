/**
 * Generic SQL database port. Platform adapters (sql.js on web, Capacitor
 * SQLite on native) implement `IDatabase`; consumers depend only on this
 * interface. Identical across consuming apps — lifted verbatim.
 */
export type QueryValue = number | string | Uint8Array | null
export type QueryParams = QueryValue[]

/** A single row of a SQL result. Use `unknown` when the caller owns the shape. */
export type Row = Record<string, unknown>

/** Connection to an opened SQL database. */
export interface IDatabase {
  /** Execute a read query; returns result rows. */
  query<T = unknown>(query: string, params?: QueryParams): Promise<T[]>
  /** Execute a write statement. */
  execute(statement: string, params?: QueryParams): Promise<void>
  /** Run multiple statements inside a transaction. Rolled back on throw. */
  transaction(fn: () => Promise<void>): Promise<void>
  /** Flush pending writes to underlying storage. */
  save(): Promise<void>
  /** Close the connection. */
  close(): Promise<void>
}

/** Factory for opening databases. */
export interface IPersistence {
  /** Open (creating if needed) the database at `dbName`. */
  open(dbName: string): Promise<IDatabase>
}
