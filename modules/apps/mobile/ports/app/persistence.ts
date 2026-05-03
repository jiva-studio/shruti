export type QueryValue = number | string | Uint8Array | null
export type QueryParams = QueryValue[]

/**
 * Interface for an opened database connection.
 */
export interface IDatabase {
  query<T = unknown>(query: string, params?: QueryParams): Promise<T[]>
  execute(statement: string, params?: QueryParams): Promise<void>
  transaction(fn: () => Promise<void>): Promise<void>
  save(): Promise<void>
  close(): Promise<void>
}

/**
 * Factory for opening databases.
 */
export interface IPersistence {
  open(dbName: string): Promise<IDatabase>
}

export type ProgressCallback = (
  receivedLength: number,
  totalLength: number,
  isDownloading: boolean
) => void

export interface IDatabaseFetcher {
  download(url: string, path: string, onProgress?: ProgressCallback): Promise<void>
  exists(path: string): Promise<boolean>
  /**
   * Deletes a previously cached database at `path`. No-op when no cached
   * copy exists. Callers must ensure the database connection is closed
   * before calling this — native filesystem adapters can't remove a file
   * held open by SQLite.
   */
  delete(path: string): Promise<void>
  /**
   * Lists storage paths of cached database files under `directory`.
   * Returns full storage paths that can be passed back into `exists()`,
   * `delete()`, etc. Returns an empty array when the directory does not
   * exist or the adapter does not support filesystem-style listing
   * (e.g. IndexedDB-backed web adapter).
   */
  list(directory: string): Promise<string[]>
}
