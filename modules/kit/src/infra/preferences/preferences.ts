/**
 * Key-value persistence for lightweight app settings.
 *
 * A minimal string-to-string store, intentionally smaller than the
 * IndexedDB blob store in `idbKv` — meant for flags, ids and small
 * serialized values, not binary payloads.
 */
export interface IPreferences {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
