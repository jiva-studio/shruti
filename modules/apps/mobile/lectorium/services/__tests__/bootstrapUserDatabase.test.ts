import { afterEach, describe, expect, it, vi } from "vitest"

import type { IDatabase } from "@ports/app/index.js"
import type { Lectorium } from "@lectorium/lectorium.js"
import { bootstrapUserDatabaseOrClose } from "../bootstrap.js"

/**
 * "Opened" and "usable" are different things, and the difference is what the
 * onboarding-loop fix rests on.
 *
 * sql.js happily constructs a Database over bytes that are not a SQLite file:
 * `persistence.open` resolves, `databases.user` is set, and the failure only
 * surfaces when a statement reaches the schema. The app then ran on a database
 * every write fails against, with the router none the wiser — which is exactly
 * the "notes silently stop saving" outcome the error screen exists to prevent.
 */
describe("bootstrapUserDatabaseOrClose", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function fakeApp(over: Partial<Lectorium> = {}): Lectorium & { closeUserDatabase: () => void } {
    const db: IDatabase = {
      query: async () => [],
      execute: async () => undefined,
      transaction: async (fn: () => Promise<void>) => fn(),
      save: async () => undefined,
      close: async () => undefined,
    }
    const databases: { content: IDatabase | null; user: IDatabase | null } = {
      content: db,
      user: null,
    }
    return {
      appConfig: { database: { userLocalPath: "user.db" } },
      databases,
      openUserDatabase: async () => {
        databases.user = db
        return db
      },
      closeUserDatabase: vi.fn(async () => {
        databases.user = null
      }),
      ...over,
    } as unknown as Lectorium & { closeUserDatabase: () => void }
  }

  it("leaves no handle behind when migrations fail on an openable file", async () => {
    const app = fakeApp()
    // A file that opens and then rejects every statement — SQLITE_NOTADB.
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const openUserDatabase = app.openUserDatabase
    const broken = {
      ...app,
      openUserDatabase: async (path: string) => {
        const db = await openUserDatabase(path)
        db.query = () => Promise.reject(new Error("file is not a database"))
        db.execute = () => Promise.reject(new Error("file is not a database"))
        return db
      },
    } as unknown as Lectorium

    await expect(bootstrapUserDatabaseOrClose(broken)).rejects.toThrow(/not a database/)
    expect(broken.databases.user).toBeNull()
  })

  it("closes the handle when the open itself rejects", async () => {
    const app = fakeApp({
      openUserDatabase: () => Promise.reject(new Error("disk I/O error")),
    })

    await expect(bootstrapUserDatabaseOrClose(app)).rejects.toThrow(/disk I\/O/)
    expect(app.closeUserDatabase).toHaveBeenCalled()
    expect(app.databases.user).toBeNull()
  })
})
