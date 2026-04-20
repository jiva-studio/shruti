import { openDatabase, closeDatabase } from "./connection.js"

/**
 * Saves a blob to IndexedDB
 * @param dbName - Database name
 * @param storeName - Object store name
 * @param key - Key to store the blob under
 * @param blob - Blob to save
 */
export async function saveBlob(
  dbName: string,
  storeName: string,
  key: string,
  blob: Blob
): Promise<void> {
  const db = await openDatabase(dbName, storeName)
  const arrayBuffer = await blob.arrayBuffer()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction([storeName], "readwrite")
    const store = transaction.objectStore(storeName)

    const request = store.put(new Uint8Array(arrayBuffer), key)

    request.onerror = () => reject(request.error)

    transaction.oncomplete = () => {
      closeDatabase(db)
      resolve()
    }

    transaction.onerror = () => reject(transaction.error)
  })
}

/**
 * Retrieves a blob from IndexedDB
 * @param dbName - Database name
 * @param storeName - Object store name
 * @param key - Key to retrieve
 * @returns Blob data or null if not found
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
 * Saves a Uint8Array to IndexedDB
 * @param dbName - Database name
 * @param storeName - Object store name
 * @param key - Key to store the data under
 * @param data - Uint8Array to save
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
 * Deletes a blob from IndexedDB
 * @param dbName - Database name
 * @param storeName - Object store name
 * @param key - Key to delete
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
