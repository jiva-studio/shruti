/**
 * Read access to the catalog's general-purpose `settings` settings store.
 * Values are opaque strings (usually JSON); the caller owns the meaning of
 * each key. Authored on the MCP side via the config registry, shipped in
 * current.db.
 */
export interface ISettingsRepository {
  /** Raw value for a key, or null when absent (or the table predates this
   *  feature on an older bundled DB). */
  get(key: string): Promise<string | null>
}
