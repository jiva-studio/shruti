/**
 * Remote config published at `{server}/public/config.json` and fetched
 * on every cold start / background refresh.
 */
export interface RemoteAppConfig {
  readonly databases: readonly RemoteDbEntry[]
}

export interface RemoteDbEntry {
  /** Timestamp-ish version, e.g. 20260419120000 (YYYYMMDDHHmmss). */
  readonly version: number
  /** Scheme number (YYYYMMDD) this DB satisfies. */
  readonly scheme?: number
}
