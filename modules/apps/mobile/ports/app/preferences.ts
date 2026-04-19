/**
 * Key-value persistence for lightweight app settings.
 */
export interface IPreferences {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}
