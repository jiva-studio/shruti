import { describe, it, expect, beforeEach, vi } from "vitest"
import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import { useWebDatabaseTransfer } from "../webDatabaseTransfer.js"
import { getBlob } from "../../idbKv.js"

const DB = "test-db"
const STORE = "blobs"
const KEY = "user.db"
const USER_DB_PATH = `${DB}/${STORE}/${KEY}`

/** Bytes that begin with the SQLite magic header. */
function sqliteBytes(): Uint8Array {
  const header = "SQLite format 3\0"
  const bytes = new Uint8Array(64)
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i)
  return bytes
}

function fileFrom(bytes: Uint8Array): File {
  return new File([bytes.buffer as ArrayBuffer], "import.db", {
    type: "application/octet-stream",
  })
}

describe("useWebDatabaseTransfer importDatabase", () => {
  beforeEach(() => {
    // Fresh IndexedDB per test.
    globalThis.indexedDB = new IDBFactory()
  })

  it("persists a valid SQLite file and re-bootstraps", async () => {
    const onImported = vi.fn()
    const transfer = useWebDatabaseTransfer({
      userDbPath: USER_DB_PATH,
      getUserDb: () => null,
      exportFileName: () => "backup.db",
      onImported,
    })

    const bytes = sqliteBytes()
    await transfer.importDatabase(fileFrom(bytes))

    const stored = await getBlob(DB, STORE, KEY)
    expect(stored).not.toBeNull()
    expect(Array.from(stored!.slice(0, bytes.length))).toEqual(Array.from(bytes))
    expect(onImported).toHaveBeenCalledOnce()
  })

  it("rejects a non-SQLite file without persisting or re-bootstrapping", async () => {
    const onImported = vi.fn()
    const transfer = useWebDatabaseTransfer({
      userDbPath: USER_DB_PATH,
      getUserDb: () => null,
      exportFileName: () => "backup.db",
      onImported,
    })

    await expect(transfer.importDatabase(fileFrom(new Uint8Array([1, 2, 3, 4])))).rejects.toThrow(
      "Selected file is not a SQLite database"
    )

    // The user DB must be untouched and the app must not re-bootstrap.
    expect(await getBlob(DB, STORE, KEY)).toBeNull()
    expect(onImported).not.toHaveBeenCalled()
  })
})
