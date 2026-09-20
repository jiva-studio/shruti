import type { IRemoteFilesStorage } from "./remoteFilesStorage.js"

/** JSON view over a format-agnostic {@link IRemoteFilesStorage}. */
export interface IJsonRemoteStorage {
  /**
   * Fetch + parse a JSON body, stale-while-revalidate (delegates caching to
   * the wrapped storage's `getText`). The parse also guards the cache: a
   * non-JSON body (e.g. a captive-portal HTML page) throws before it's
   * written, so the previous good body survives.
   */
  getJson<T = unknown>(url: string): Promise<T>
}

/**
 * Wrap a remote files storage with JSON parsing, keeping the storage itself
 * format-agnostic. The parse runs both as the pre-cache validator (passed to
 * `getText`, so garbage is never persisted) and on the returned body.
 */
export function createJsonRemoteStorage(storage: IRemoteFilesStorage): IJsonRemoteStorage {
  return {
    async getJson<T = unknown>(url: string): Promise<T> {
      const text = await storage.getText(url, { validate: (t) => void JSON.parse(t) })
      return JSON.parse(text) as T
    },
  }
}
