import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../adoptAnonymousChanges.js", () => ({
  adoptAnonymousChanges: async () => ({ docs: 0 }),
}))

import { createCursorOwnerGuard, type CursorOwnerDeps } from "../cursorOwnerGuard.js"

/**
 * The cursor-owner marker is what makes an account switch detectable, so the
 * guard only treats an identity as handled once every preference write for it
 * has landed. A failed write surfaces and the next call does the work again.
 */

const OWNER = "sync.cursorOwner"
const OWNER_ANON = "sync.cursorOwnerAnon"
const RETIRED = "sync.retiredOutboxId"

let prefs: Map<string, string>
/** Keys whose next `set` rejects, consumed as they fail. */
let failNextSet: Set<string>
let identity: { userId: string | null; anonymous: boolean }
let pushedOutboxId: number

function createDeps(): CursorOwnerDeps {
  const syncState = {
    setPullCursor: vi.fn(async () => {}),
    setAckedSeq: vi.fn(async () => {}),
    getPushedOutboxId: async () => pushedOutboxId,
    setPushedOutboxId: vi.fn(async (id: number) => {
      pushedOutboxId = id
    }),
  }
  const repositories = () => ({
    syncState,
    syncOutbox: { latestId: async () => 42 },
    syncApply: {},
    unitOfWork: { run: async <T>(fn: (tx: unknown) => Promise<T>) => fn({ kind: "transaction" }) },
  })
  return {
    markers: {
      get: async (k: string) => prefs.get(k) ?? null,
      set: async (k: string, v: string) => {
        if (failNextSet.delete(k)) throw new Error(`disk full writing ${k}`)
        prefs.set(k, v)
      },
      remove: async (k: string) => {
        prefs.delete(k)
      },
    },
    listMarkerKeys: async () => [...prefs.keys()],
    repositories: repositories as unknown as CursorOwnerDeps["repositories"],
    identity: () => identity,
    isEnabled: () => true,
  }
}

beforeEach(() => {
  prefs = new Map([
    [OWNER, "user-a"],
    [OWNER_ANON, "0"],
  ])
  failNextSet = new Set()
  identity = { userId: "user-b", anonymous: false }
  pushedOutboxId = 0
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("createCursorOwnerGuard — persistence failures", () => {
  it("retries the switch when the owner marker could not be written", async () => {
    const ensure = createCursorOwnerGuard(createDeps())
    failNextSet.add(OWNER)

    await ensure()
    expect(prefs.get(OWNER)).toBe("user-a")

    await ensure()
    expect(prefs.get(OWNER)).toBe("user-b")
  })

  it("retries when the retired-journal floor could not be written", async () => {
    const ensure = createCursorOwnerGuard(createDeps())
    failNextSet.add(RETIRED)

    await ensure()
    expect(prefs.has(RETIRED)).toBe(false)

    await ensure()
    expect(prefs.get(RETIRED)).toBe("42")
  })

  it("surfaces a failed write for the same account and records it on the next call", async () => {
    prefs.set(OWNER, "user-b")
    prefs.set(OWNER_ANON, "1")
    const ensure = createCursorOwnerGuard(createDeps())
    failNextSet.add(OWNER_ANON)

    await expect(ensure()).rejects.toThrow(/disk full/)

    await ensure()
    expect(prefs.get(OWNER_ANON)).toBe("0")
  })

  it("does no work twice once everything is persisted", async () => {
    const deps = createDeps()
    const ensure = createCursorOwnerGuard(deps)

    await ensure()
    await ensure()

    const { syncState } = deps.repositories() as unknown as {
      syncState: { setPullCursor: ReturnType<typeof vi.fn> }
    }
    expect(syncState.setPullCursor).toHaveBeenCalledTimes(1)
    expect(prefs.get(OWNER)).toBe("user-b")
    expect(prefs.get(RETIRED)).toBe("42")
  })
})

// Installed builds read these preference keys and values: pinned as literals,
// never through the module's constants.
describe("createCursorOwnerGuard — persisted marker keys", () => {
  it("records a first-run anonymous owner under the exact keys", async () => {
    prefs = new Map()
    identity = { userId: "anon-1", anonymous: true }

    await createCursorOwnerGuard(createDeps())()

    expect(Object.fromEntries(prefs)).toEqual({
      "sync.cursorOwner": "anon-1",
      "sync.cursorOwnerAnon": "1",
      "sync.cursorOwnerOrigin": "first-run",
    })
  })

  it("marks an anonymous identity that took over from another as replaced", async () => {
    prefs = new Map([
      ["sync.cursorOwner", "anon-1"],
      ["sync.cursorOwnerAnon", "1"],
      ["sync.cursorOwnerOrigin", "first-run"],
    ])
    identity = { userId: "anon-2", anonymous: true }

    await createCursorOwnerGuard(createDeps())()

    expect(Object.fromEntries(prefs)).toEqual({
      "sync.cursorOwner": "anon-2",
      "sync.cursorOwnerAnon": "1",
      "sync.cursorOwnerOrigin": "replaced",
    })
  })

  it("writes the retired floor under sync.retiredOutboxId on a signed-in switch", async () => {
    await createCursorOwnerGuard(createDeps())()

    expect(Object.fromEntries(prefs)).toEqual({
      "sync.cursorOwner": "user-b",
      "sync.cursorOwnerAnon": "0",
      "sync.retiredOutboxId": "42",
    })
  })

  it("recovers a legacy first-run origin unless another account's backfill marker exists", async () => {
    const legacy = (backfilled: string) =>
      new Map([
        ["sync.cursorOwner", "anon-1"],
        ["sync.cursorOwnerAnon", "1"],
        [`sync.backfilled.${backfilled}`, "1"],
      ])
    identity = { userId: "anon-1", anonymous: true }

    prefs = legacy("anon-1")
    await createCursorOwnerGuard(createDeps())()
    expect(prefs.get("sync.cursorOwnerOrigin")).toBe("first-run")

    prefs = legacy("user-z")
    await createCursorOwnerGuard(createDeps())()
    expect(prefs.has("sync.cursorOwnerOrigin")).toBe(false)
  })
})
