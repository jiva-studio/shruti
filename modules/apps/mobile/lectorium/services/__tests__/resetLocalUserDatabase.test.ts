import { describe, expect, it, vi } from "vitest"
import type { Lectorium } from "../../lectorium.js"
import { resetLocalUserDatabase, resetLocalUserDatabaseFromApp } from "../dataWipe.js"

/**
 * The recovery path for a `user.db` that will not open or migrate (#1831).
 *
 * Everything here is about what it must NOT do: it must not read a row, must
 * not build a repository, and must not give up because the close failed —
 * because the state it exists for is exactly the one where all of that breaks.
 */
describe("resetLocalUserDatabase", () => {
  it("closes the connection before deleting the file", async () => {
    const calls: string[] = []

    await resetLocalUserDatabase({
      userDbPath: "user.db",
      closeUserDatabase: async () => {
        calls.push("close")
      },
      deleteDatabase: async (path) => {
        calls.push(`delete:${path}`)
      },
    })

    // Reversed, the native adapter is asked to remove a file SQLite still
    // holds open — which silently fails on Android.
    expect(calls).toEqual(["close", "delete:user.db"])
  })

  it("still deletes when closing throws", async () => {
    const deleteDatabase = vi.fn().mockResolvedValue(undefined)

    await resetLocalUserDatabase({
      userDbPath: "user.db",
      closeUserDatabase: async () => {
        throw new Error("connection is not open")
      },
      deleteDatabase,
    })

    // A handle that never opened is the common case here, not an obstacle.
    expect(deleteDatabase).toHaveBeenCalledWith("user.db")
  })

  it("propagates a failed delete so the caller can say so", async () => {
    await expect(
      resetLocalUserDatabase({
        userDbPath: "user.db",
        closeUserDatabase: async () => undefined,
        deleteDatabase: async () => {
          throw new Error("read-only file system")
        },
      })
    ).rejects.toThrow("read-only file system")
  })
})

describe("resetLocalUserDatabaseFromApp", () => {
  it("never reaches for repositories()", async () => {
    const deleteDatabase = vi.fn().mockResolvedValue(undefined)
    const app = {
      appConfig: { database: { userLocalPath: "user.db" } },
      closeUserDatabase: async () => undefined,
      persistence: { deleteDatabase },
      repositories: () => {
        throw new Error("repositories(): user DB is not open yet")
      },
    } as unknown as Lectorium

    await resetLocalUserDatabaseFromApp(app)

    // `wipeLocalUserData` opens with `app.repositories()` and therefore cannot
    // run in this state at all — the whole reason this path exists.
    expect(deleteDatabase).toHaveBeenCalledWith("user.db")
  })
})
