import { beforeEach, describe, expect, it, vi } from "vitest"

const fakeDb = {
  open: vi.fn().mockResolvedValue(undefined),
  run: vi.fn().mockResolvedValue(undefined),
  query: vi.fn().mockResolvedValue({ values: [] }),
  close: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  beginTransaction: vi.fn().mockResolvedValue(undefined),
  commitTransaction: vi.fn().mockResolvedValue(undefined),
  rollbackTransaction: vi.fn().mockResolvedValue(undefined),
}

const plugin = {
  checkConnectionsConsistency: vi.fn(),
  isNCConnection: vi.fn(),
  closeNCConnection: vi.fn(),
  isConnection: vi.fn(),
  closeConnection: vi.fn(),
  getNCDatabasePath: vi.fn(),
  createNCConnection: vi.fn(),
  createConnection: vi.fn(),
}

const mkdirMock = vi.fn()
const deleteFileMock = vi.fn()
let platform = "android"

vi.mock("@capacitor-community/sqlite", () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    checkConnectionsConsistency = (...a: unknown[]) => plugin.checkConnectionsConsistency(...a)
    isNCConnection = (...a: unknown[]) => plugin.isNCConnection(...a)
    closeNCConnection = (...a: unknown[]) => plugin.closeNCConnection(...a)
    isConnection = (...a: unknown[]) => plugin.isConnection(...a)
    closeConnection = (...a: unknown[]) => plugin.closeConnection(...a)
    getNCDatabasePath = (...a: unknown[]) => plugin.getNCDatabasePath(...a)
    createNCConnection = (...a: unknown[]) => plugin.createNCConnection(...a)
    createConnection = (...a: unknown[]) => plugin.createConnection(...a)
  },
}))
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => platform } }))
vi.mock("@capacitor/filesystem", () => ({
  Filesystem: {
    mkdir: (...a: unknown[]) => mkdirMock(...a),
    deleteFile: (...a: unknown[]) => deleteFileMock(...a),
  },
  Directory: { Data: "DATA" },
}))

import { useCapacitorSqlPersistence } from "../useCapacitorSqlPersistence.js"

beforeEach(() => {
  platform = "android"
  vi.clearAllMocks()
  plugin.checkConnectionsConsistency.mockResolvedValue(undefined)
  plugin.isNCConnection.mockResolvedValue({ result: false })
  plugin.closeNCConnection.mockResolvedValue(undefined)
  plugin.isConnection.mockResolvedValue({ result: false })
  plugin.closeConnection.mockResolvedValue(undefined)
  plugin.getNCDatabasePath.mockResolvedValue({ path: "/data/files/databases/content.db" })
  plugin.createNCConnection.mockResolvedValue(fakeDb)
  plugin.createConnection.mockResolvedValue(fakeDb)
  mkdirMock.mockResolvedValue(undefined)
  deleteFileMock.mockResolvedValue(undefined)
})

describe("useCapacitorSqlPersistence — open()", () => {
  it("opens a database with a directory as a plain file under the data directory", async () => {
    await useCapacitorSqlPersistence().open("databases/content.db")

    expect(mkdirMock).toHaveBeenCalledWith({
      path: "databases",
      directory: "DATA",
      recursive: true,
    })
    expect(plugin.getNCDatabasePath).toHaveBeenCalledWith("files/databases", "content.db")
    expect(plugin.createNCConnection).toHaveBeenCalledWith("/data/files/databases/content.db", 1)
    expect(plugin.createConnection).not.toHaveBeenCalled()
  })

  it("resolves the same path under Documents on iOS and bare on the web", async () => {
    platform = "ios"
    await useCapacitorSqlPersistence().open("databases/content.db")
    expect(plugin.getNCDatabasePath).toHaveBeenCalledWith("Documents/databases", "content.db")

    platform = "web"
    await useCapacitorSqlPersistence().open("databases/content.db")
    expect(plugin.getNCDatabasePath).toHaveBeenLastCalledWith("databases", "content.db")
  })

  it("opens a bare name as a plugin-sandboxed connection, without the suffix", async () => {
    await useCapacitorSqlPersistence().open("user.db")

    expect(plugin.createConnection).toHaveBeenCalledWith("user", false, "no-encryption", 1, false)
    expect(plugin.createNCConnection).not.toHaveBeenCalled()
    expect(mkdirMock).not.toHaveBeenCalled()
  })

  it("fails loudly when the plugin cannot resolve the file's path", async () => {
    plugin.getNCDatabasePath.mockResolvedValue({ path: "" })

    await expect(useCapacitorSqlPersistence().open("databases/content.db")).rejects.toThrow(
      "Failed to get NC database path for files/databases/content.db"
    )
  })

  it("closes a connection the previous webview session left open", async () => {
    plugin.isNCConnection.mockResolvedValue({ result: true })

    await useCapacitorSqlPersistence().open("databases/content.db")

    expect(plugin.closeNCConnection).toHaveBeenCalledWith("/data/files/databases/content.db")
  })

  it("opens anyway when the plugin cannot tell whether a stale connection exists", async () => {
    plugin.isConnection.mockRejectedValue(new Error("plugin unavailable"))

    await expect(useCapacitorSqlPersistence().open("user.db")).resolves.toBeDefined()
    expect(plugin.createConnection).toHaveBeenCalled()
  })

  it("reconciles the native registry once per instance, however many databases open", async () => {
    const persistence = useCapacitorSqlPersistence()
    await persistence.open("user.db")
    await persistence.open("databases/content.db")

    expect(plugin.checkConnectionsConsistency).toHaveBeenCalledTimes(1)
  })

  it("opens even when the reconciliation itself fails", async () => {
    plugin.checkConnectionsConsistency.mockRejectedValue(new Error("nothing to reconcile"))

    await expect(useCapacitorSqlPersistence().open("user.db")).resolves.toBeDefined()
  })

  it("closes the connection the database was opened on", async () => {
    const nc = await useCapacitorSqlPersistence().open("databases/content.db")
    await nc.close()
    expect(plugin.closeNCConnection).toHaveBeenCalledWith("/data/files/databases/content.db")

    const regular = await useCapacitorSqlPersistence().open("user.db")
    await regular.close()
    expect(plugin.closeConnection).toHaveBeenCalledWith("user", false)
  })
})

describe("useCapacitorSqlPersistence — deleteDatabase()", () => {
  it("removes a file-backed database through the filesystem", async () => {
    await useCapacitorSqlPersistence().deleteDatabase("databases/content.db")

    expect(deleteFileMock).toHaveBeenCalledWith({
      path: "databases/content.db",
      directory: "DATA",
    })
    expect(plugin.createConnection).not.toHaveBeenCalled()
  })

  it("releases a connection still held on the file before removing it", async () => {
    plugin.isNCConnection.mockResolvedValue({ result: true })

    await useCapacitorSqlPersistence().deleteDatabase("databases/content.db")

    expect(plugin.closeNCConnection).toHaveBeenCalledWith("/data/files/databases/content.db")
  })

  it("is satisfied when the file is already gone", async () => {
    deleteFileMock.mockRejectedValue(new Error("File does not exist"))

    await expect(
      useCapacitorSqlPersistence().deleteDatabase("databases/content.db")
    ).resolves.toBeUndefined()
  })

  it("deletes a sandboxed database through the plugin, which needs a connection for it", async () => {
    await useCapacitorSqlPersistence().deleteDatabase("user.db")

    expect(plugin.createConnection).toHaveBeenCalledWith("user", false, "no-encryption", 1, false)
    expect(fakeDb.delete).toHaveBeenCalled()
    expect(fakeDb.open).not.toHaveBeenCalled()
    expect(deleteFileMock).not.toHaveBeenCalled()
  })

  it("leaves no connection behind when the delete fails", async () => {
    fakeDb.delete.mockRejectedValueOnce(new Error("database is locked"))
    plugin.isConnection.mockResolvedValue({ result: true })

    await expect(useCapacitorSqlPersistence().deleteDatabase("user.db")).rejects.toThrow(
      "database is locked"
    )
    expect(plugin.closeConnection).toHaveBeenCalledWith("user", false)
  })
})
