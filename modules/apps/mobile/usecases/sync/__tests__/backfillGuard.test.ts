import { beforeEach, describe, expect, it, vi } from "vitest"

const backfill = vi.hoisted(() => ({ calls: [] as { ownerId: string }[], fail: false }))
vi.mock("../backfillLocal.js", () => ({
  backfillLocal: async (deps: { ownerId: string }) => {
    backfill.calls.push(deps)
    if (backfill.fail) throw new Error("locked")
    return { enqueued: 1, collections: [] }
  },
}))

import { createBackfillGuard, type BackfillDeps } from "../backfillGuard.js"

const REPOS = {
  syncBackfill: {},
  syncOutbox: {},
  syncState: {},
  syncApply: {},
  unitOfWork: {},
}

let prefs: Map<string, string>
let identity: string | null
let enabled: boolean

function guard(repos: () => unknown = () => REPOS) {
  const deps: BackfillDeps = {
    markers: {
      get: async (k) => prefs.get(k) ?? null,
      set: async (k, v) => void prefs.set(k, v),
      remove: async (k) => void prefs.delete(k),
    },
    repositories: repos as BackfillDeps["repositories"],
    clock: { now: () => 0 },
    identity: () => identity,
    isEnabled: () => enabled,
  }
  return createBackfillGuard(deps)
}

beforeEach(() => {
  prefs = new Map()
  identity = "user-1"
  enabled = true
  backfill.calls = []
  backfill.fail = false
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
})

describe("createBackfillGuard — run", () => {
  it("backfills once per account and records sync.backfilled.<userId>", async () => {
    const g = guard()

    await g.run()
    await g.run()

    expect(backfill.calls).toHaveLength(1)
    expect(backfill.calls[0]!.ownerId).toBe("user-1")
    expect(Object.fromEntries(prefs)).toEqual({ "sync.backfilled.user-1": "1" })
  })

  it("skips an account whose marker already exists", async () => {
    prefs.set("sync.backfilled.user-1", "1")

    await guard().run()

    expect(backfill.calls).toEqual([])
  })

  it.each([
    ["the engine is off", () => void (enabled = false)],
    ["no account exists yet", () => void (identity = null)],
  ])("does nothing while %s", async (_, arrange) => {
    arrange()

    await guard().run()

    expect(backfill.calls).toEqual([])
    expect(prefs.size).toBe(0)
  })

  it.each(["syncBackfill", "syncOutbox", "syncState", "syncApply"])(
    "waits while %s is not wired",
    async (missing) => {
      await guard(() => ({ ...REPOS, [missing]: undefined })).run()
      expect(backfill.calls).toEqual([])
    }
  )

  it("waits while the user database is closed", async () => {
    await guard(() => {
      throw new Error("not open")
    }).run()
    expect(backfill.calls).toEqual([])
  })

  it("retries on the next run after a failed backfill", async () => {
    const g = guard()
    backfill.fail = true
    await g.run()
    expect(prefs.size).toBe(0)

    backfill.fail = false
    await g.run()
    expect(backfill.calls).toHaveLength(2)
    expect(prefs.get("sync.backfilled.user-1")).toBe("1")
  })
})

describe("createBackfillGuard — rearmForChats", () => {
  it("drops the marker and the in-memory echo so the backfill runs again", async () => {
    const g = guard()
    await g.run()

    await g.rearmForChats()
    expect(prefs.has("sync.backfilled.user-1")).toBe(false)
    await g.run()

    expect(backfill.calls).toHaveLength(2)
  })
})
