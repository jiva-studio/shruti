import { beforeEach, describe, expect, it, vi } from "vitest"
import type { IPreferences } from "@ports/app/index.js"
import type { Shruti } from "@shruti/shruti.js"

const reportError = vi.hoisted(() => vi.fn())
vi.mock("@shruti/services/monitoring/reportError.js", () => ({ reportError }))

import { resolveInitialRoute } from "../startupRoute.js"

const boom = new Error("preferences unavailable")

function appWithHistory(hasHistory: boolean): Shruti {
  return {
    databases: { content: {}, user: {} },
    repositories: () => ({ listeningSessions: { hasAny: async () => hasHistory } }),
  } as unknown as Shruti
}

function preferences(over: Partial<IPreferences>): IPreferences {
  return {
    get: async () => null,
    set: async () => {},
    remove: async () => {},
    ...over,
  } as IPreferences
}

beforeEach(() => {
  reportError.mockClear()
})

describe("resolveInitialRoute — preferences that fail", () => {
  it("reports an onboarding flag it cannot read and falls back to the listening history", async () => {
    const prefs = preferences({ get: async () => Promise.reject(boom) })

    expect(await resolveInitialRoute(appWithHistory(true), prefs, true)).toBe("/tabs/home")
    expect(reportError).toHaveBeenCalledWith("startup", boom)
  })

  it("reports an unreadable flag and onboards a listener with no history", async () => {
    const set = vi.fn(async () => {})
    const prefs = preferences({ get: async () => Promise.reject(boom), set })

    expect(await resolveInitialRoute(appWithHistory(false), prefs, true)).toBe("/onboarding")
    expect(reportError).toHaveBeenCalledWith("startup", boom)
    expect(set).not.toHaveBeenCalled()
  })

  it("reports an inferred flag it cannot write and still lands on home", async () => {
    const prefs = preferences({ set: async () => Promise.reject(boom) })

    expect(await resolveInitialRoute(appWithHistory(true), prefs, true)).toBe("/tabs/home")
    expect(reportError).toHaveBeenCalledWith("startup", boom)
  })
})
