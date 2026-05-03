import { openDatabase, closeDatabase } from "./connection.js"

/**
 * Checks if a key exists in IndexedDB
 * @param dbName - Database name
 * @param storeName - Object store name
 * @param key - Key to check
 * @returns True if the key exists, false otherwise
 */
export async function keyExists(dbName: string, storeName: string, key: string): Promise<boolean> {
  try {
    const db = await openDatabase(dbName, storeName)

    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], "readonly")
      const store = transaction.objectStore(storeName)

      const request = store.get(key)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        closeDatabase(db)
        resolve(request.result !== undefined)
      }

      transaction.onerror = () => reject(transaction.error)
    })
  } catch {
    // If database doesn't exist yet, return false
    return false
  }
}

/**
 * Gets all keys from an object store
 * @param dbName - Database name
 * @param storeName - Object store name
 * @returns Array of all keys
 */
export async function getAllKeys(dbName: string, storeName: string): Promise<string[]> {
  const db = await openDatabase(dbName, storeName)

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], "readonly")
    const store = transaction.objectStore(storeName)

    const request = store.getAllKeys()

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      closeDatabase(db)
      resolve(request.result as string[])
    }

    transaction.onerror = () => reject(transaction.error)
  })
}

/**
 * Gets storage information for an object store
 * @param dbName - Database name
 * @param storeName - Object store name
 * @returns Storage information including key count
 */
export async function getStorageInfo(
  dbName: string,
  storeName: string
): Promise<{ keyCount: number }> {
  const db = await openDatabase(dbName, storeName)

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], "readonly")
    const store = transaction.objectStore(storeName)

    const request = store.count()

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      closeDatabase(db)
      resolve({ keyCount: request.result })
    }

    transaction.onerror = () => reject(transaction.error)
  })
}
