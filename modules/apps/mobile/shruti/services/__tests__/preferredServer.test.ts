import { describe, expect, it, vi } from "vitest"
import type { IPreferences } from "@ports/app/index.js"
import { PREFERRED_SERVER_KEY, readPreferredServerId } from "../preferredServer.js"

function preferences(read: () => Promise<string | null>): IPreferences {
  return {
    get: read,
    set: async () => {},
    remove: async () => {},
  }
}

describe("readPreferredServerId", () => {
  it("returns the region the user last landed on", async () => {
    const keys: string[] = []
    const prefs: IPreferences = {
      get: async (key) => {
        keys.push(key)
        return "asia"
      },
      set: async () => {},
      remove: async () => {},
    }

    expect(await readPreferredServerId(prefs)).toBe("asia")
    expect(keys).toEqual([PREFERRED_SERVER_KEY])
  })

  it("treats a missing preference as no choice", async () => {
    expect(await readPreferredServerId(preferences(async () => null))).toBeNull()
  })

  it("treats an empty preference as no choice", async () => {
    expect(await readPreferredServerId(preferences(async () => ""))).toBeNull()
  })

  it("treats an unreadable store as no choice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const result = await readPreferredServerId(
      preferences(async () => {
        throw new Error("preferences unavailable")
      })
    )

    expect(result).toBeNull()
    warn.mockRestore()
  })
})
