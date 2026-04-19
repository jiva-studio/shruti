import type { IDatabaseFetcher, ProgressCallback } from "@ports/app/index.js"
import { saveBlob, keyExists, deleteBlob } from "@infra/idb.kv/index.js"
import { downloadWithProgress } from "./streamDownloader.js"

/**
 * Creates a database fetcher using fetch and IndexedDB for web platform
 * @returns Database fetcher for IndexedDB storage
 */
export function useDatabaseToIndexedDbFetcher(): IDatabaseFetcher {
  let isDownloading = false

  /**
   * Downloads a database file from a URL and saves it to IndexedDB
   * @param url - The URL to download from
   * @param path - The IndexedDB path in format "dbName/storeName/key"
   * @param onProgress - Optional callback for progress updates (receivedLength, totalLength, isDownloading)
   */
  const download = async (
    url: string,
    path: string,
    onProgress?: ProgressCallback
  ): Promise<void> => {
    if (isDownloading) {
      throw new Error("Download already in progress")
    }

    try {
      isDownloading = true
      onProgress?.(0, 0, true)

      const [dbName, storeName, key] = path.split("/")
      const blob = await downloadWithProgress(url, (receivedLength, totalLength) => {
        onProgress?.(receivedLength, totalLength, true)
      })
      await saveBlob(dbName, storeName, key, blob)

      onProgress?.(0, 0, true)
    } finally {
      isDownloading = false
      onProgress?.(0, 0, false)
    }
  }

  /**
   * Checks if the database file exists in IndexedDB
   * @param path - The IndexedDB path in format "dbName/storeName/key"
   */
  const exists = async (path: string): Promise<boolean> => {
    const [dbName, storeName, key] = path.split("/")
    return keyExists(dbName, storeName, key)
  }

  /**
   * Deletes a cached database blob from IndexedDB.
   * No-op when the key does not exist.
   * @param path - The IndexedDB path in format "dbName/storeName/key"
   */
  const remove = async (path: string): Promise<void> => {
    const [dbName, storeName, key] = path.split("/")
    await deleteBlob(dbName, storeName, key)
  }

  /**
   * IndexedDB adapter doesn't support filesystem-style directory listing:
   * blobs live under arbitrary (dbName, storeName, key) tuples and we don't
   * enumerate them. Callers treat an empty list as "no local DB available"
   * and fall back to a CDN download, which is the correct web behaviour.
   */
  const list = async (): Promise<string[]> => []

  return {
    download,
    exists,
    delete: remove,
    list,
  }
}
