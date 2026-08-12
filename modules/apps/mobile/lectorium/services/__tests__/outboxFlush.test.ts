import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Lectorium } from "../../lectorium.js"
import { flushPendingOutbox } from "../outboxFlush.js"

/**
 * The farewell push (#1773). It runs while the outgoing account's token is
 * still live and just before the wipe empties the journal, so its gates matter
 * more than its happy path: a region without `profileBaseUrl` has no sync
 * service to push to, and a device whose engine repositories were never wired
 * has journaled nothing.
 */

const pushLocal = vi.fn().mockResolvedValue({ pushed: 0, conflicts: 0, changedCollections: [] })

vi.mock("@usecases/sync/index.js", () => ({
  pushLocal: (...args: unknown[]) => pushLocal(...args),
}))

const engineRepos = {
  syncOutbox: { id: "outbox" },
  syncApply: { id: "apply" },
  syncState: { id: "state" },
  unitOfWork: { id: "uow" },
}

function makeApp(over: {
  profileBaseUrl?: string | undefined
  repositories?: () => unknown
}): Lectorium {
  return {
    activeServer: { value: { profileBaseUrl: over.profileBaseUrl } },
    repositories: over.repositories ?? (() => engineRepos),
    syncClient: { id: "gateway" },
  } as unknown as Lectorium
}

describe("flushPendingOutbox", () => {
  beforeEach(() => {
    pushLocal.mockReset().mockResolvedValue({ pushed: 0, conflicts: 0, changedCollections: [] })
  })

  it("drains the outgoing account's rows through the sync gateway", async () => {
    await flushPendingOutbox({
      app: makeApp({ profileBaseUrl: "https://profile.example" }),
      ownerId: "u-1",
      getLiveOwnerId: () => "u-1",
    })

    expect(pushLocal).toHaveBeenCalledOnce()
    expect(pushLocal.mock.calls[0]![0]).toMatchObject({
      ownerId: "u-1",
      outbox: engineRepos.syncOutbox,
      apply: engineRepos.syncApply,
      syncState: engineRepos.syncState,
    })
    // The drain stops itself rather than POSTing under a token that changed
    // hands while a round was in flight.
    expect(pushLocal.mock.calls[0]![0]).toHaveProperty("getLiveOwnerId")
  })

  it("does nothing in a region without a profile service", async () => {
    await flushPendingOutbox({
      app: makeApp({ profileBaseUrl: undefined }),
      ownerId: "u-1",
      getLiveOwnerId: () => "u-1",
    })
    expect(pushLocal).not.toHaveBeenCalled()
  })

  it("does nothing when the engine repositories were never wired", async () => {
    const app = makeApp({
      profileBaseUrl: "https://profile.example",
      repositories: () => ({ unitOfWork: engineRepos.unitOfWork }),
    })
    await flushPendingOutbox({ app, ownerId: "u-1", getLiveOwnerId: () => "u-1" })
    expect(pushLocal).not.toHaveBeenCalled()
  })

  it("does nothing when the database is not open yet", async () => {
    const app = makeApp({
      profileBaseUrl: "https://profile.example",
      repositories: () => {
        throw new Error("repositories not open")
      },
    })
    await expect(
      flushPendingOutbox({ app, ownerId: "u-1", getLiveOwnerId: () => "u-1" })
    ).resolves.toBeUndefined()
    expect(pushLocal).not.toHaveBeenCalled()
  })

  it("gives up on a push that never answers, so the sign-out can proceed", async () => {
    vi.useFakeTimers()
    pushLocal.mockReturnValue(new Promise(() => undefined))
    const flushed = flushPendingOutbox({
      app: makeApp({ profileBaseUrl: "https://profile.example" }),
      ownerId: "u-1",
      getLiveOwnerId: () => "u-1",
    })
    const settled = expect(flushed).rejects.toThrow(/timeout/)
    await vi.advanceTimersByTimeAsync(10_000)
    await settled
    vi.useRealTimers()
  })
})
