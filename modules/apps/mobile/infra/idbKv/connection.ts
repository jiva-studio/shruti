/**
 * Ensures an object store exists in the database, creating it if necessary
 * @param dbName - Database name
 * @param storeName - Object store name
 * @param currentVersion - Current database version
 * @returns Database with the object store
 */
async function ensureObjectStore(
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
 * Opens or creates IndexedDB database, ensuring the required object store exists
 * @param dbName - Database name
 * @param storeName - Object store name to ensure exists
 * @returns Opened database connection
 */
export async function openDatabase(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // First, open without version to check current state
    const checkRequest = indexedDB.open(dbName)

    checkRequest.onerror = () => reject(checkRequest.error)

    checkRequest.onsuccess = async () => {
      const db = checkRequest.result
      const currentVersion = db.version

      // Check if the required object store exists
      if (db.objectStoreNames.contains(storeName)) {
        resolve(db)
      } else {
        db.close()

        try {
          const upgradedDb = await ensureObjectStore(dbName, storeName, currentVersion)
          resolve(upgradedDb)
        } catch (error) {
          reject(error)
        }
      }
    }

    checkRequest.onupgradeneeded = (event) => {
      // Database doesn't exist yet, create it with the store
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName)
      }
    }
  })
}

/**
 * Closes a database connection
 * @param db - Database to close
 */
export function closeDatabase(db: IDBDatabase): void {
  db.close()
}
