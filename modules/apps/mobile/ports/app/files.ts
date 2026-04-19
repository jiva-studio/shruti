/**
 * Port for a remote files cache. Implementations fetch a file from its URL
 * on first access, cache it under a platform-specific store (Cache API on
 * web, Filesystem on Capacitor), and return a local URL the UI can put into
 * `<img src>` / `<audio src>` attributes without re-downloading on subsequent
 * accesses.
 */
export interface IRemoteFilesStorage {
  get(url: string): Promise<string>
  has(url: string): Promise<boolean>
  delete(url: string): Promise<void>
  clearAll(): Promise<void>
}
