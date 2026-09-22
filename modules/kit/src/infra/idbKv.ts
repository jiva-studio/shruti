/**
 * Generic IndexedDB key-value blob store.
 *
 * A thin promise-based wrapper over the IndexedDB API for persisting binary
 * blobs (`Uint8Array`) under string keys inside a named object store. Each
 * operation opens a short-lived connection, runs a single transaction and
 * closes it again, so callers never have to manage connection lifetime.
 *
 * Framework-agnostic: no app, schema or domain assumptions — pass the
 * database name, store name and key explicitly. Requires a global
 * `indexedDB` (browser / worker, or a polyfill such as `fake-indexeddb`).
 */

/**
 * Ensures an object store exists, creating it via a version bump if necessary.
 */
function ensureObjectStore(
  dbName: string,
  storeName: string,
  currentVersion: number
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const upgradeRequest = indexedDB.open(dbName, currentVersion + 1)

    upgradeRequest.onerror = () => reject(upgradeRequest.error)
    upgradeRequest.onsuccess = () => resolve(upgradeRequest.result)

    upgradeRequest.onupgradeneeded = (event) => {
      const upgradedDb = (event.target as IDBOpenDBRequest).result
      if (!upgradedDb.objectStoreNames.contains(storeName)) {
        upgradedDb.createObjectStore(storeName)
      }
    }
  })
}

/**
 * Opens (creating if needed) an IndexedDB database, guaranteeing the requested
 * object store exists.
 *
 * @param dbName - Database name.
 * @param storeName - Object store to ensure exists.
 * @returns An open database connection.
 */
export function openDatabase(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // First, open without a version to inspect the current state.
    const checkRequest = indexedDB.open(dbName)

    checkRequest.onerror = () => reject(checkRequest.error)

    checkRequest.onsuccess = () => {
      const db = checkRequest.result
      const currentVersion = db.version

      if (db.objectStoreNames.contains(storeName)) {
        resolve(db)
      } else {
        db.close()
        ensureObjectStore(dbName, storeName, currentVersion).then(resolve, reject)
      }
    }

    checkRequest.onupgradeneeded = (event) => {
      // Database did not exist — create it with the store in place.
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName)
      }
    }
  })
}

/**
 * Closes a database connection.
 */
export function closeDatabase(db: IDBDatabase): void {
  db.close()
}

/**
 * Saves a `Blob` under `key`. The blob is read into memory and stored as a
 * `Uint8Array`.
 */
export async function saveBlob(
  dbName: string,
  storeName: string,
  key: string,
  blob: Blob
): Promise<void> {
  const arrayBuffer = await blob.arrayBuffer()
  return saveData(dbName, storeName, key, new Uint8Array(arrayBuffer))
}

/**
 * Saves raw bytes under `key`, overwriting any existing value.
 */
export async function saveData(
  dbName: string,
  storeName: string,
  key: string,
  data: Uint8Array
): Promise<void> {
  const db = await openDatabase(dbName, storeName)

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], "readwrite")
    const store = transaction.objectStore(storeName)

    const request = store.put(data, key)

    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => {
      closeDatabase(db)
      resolve()
    }
    transaction.onerror = () => reject(transaction.error)
  })
}

/**
 * Retrieves the bytes stored under `key`, or `null` if the key is absent.
 */
export async function getBlob(
  dbName: string,
  storeName: string,
  key: string
): Promise<Uint8Array | null> {
  const db = await openDatabase(dbName, storeName)

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], "readonly")
    const store = transaction.objectStore(storeName)

    const request = store.get(key)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      closeDatabase(db)
      resolve(request.result !== undefined ? request.result : null)
    }
    transaction.onerror = () => reject(transaction.error)
  })
}

/**
 * Deletes the value stored under `key`. A no-op if the key is absent.
 */
export async function deleteBlob(dbName: string, storeName: string, key: string): Promise<void> {
  const db = await openDatabase(dbName, storeName)

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], "readwrite")
    const store = transaction.objectStore(storeName)

    const request = store.delete(key)

    request.onerror = () => reject(request.error)
    transaction.oncomplete = () => {
      closeDatabase(db)
      resolve()
    }
    transaction.onerror = () => reject(transaction.error)
  })
}

/**
 * Returns whether `key` exists in the store. Returns `false` if the database
 * does not exist yet.
 */
export async function keyExists(dbName: string, storeName: string, key: string): Promise<boolean> {
  try {
    const db = await openDatabase(dbName, storeName)

    return await new Promise((resolve, reject) => {
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
    // Database does not exist yet — treat as "no such key".
    return false
  }
}

/**
 * Returns every key in the store.
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
 * Returns coarse storage information for the store (the number of stored keys).
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
