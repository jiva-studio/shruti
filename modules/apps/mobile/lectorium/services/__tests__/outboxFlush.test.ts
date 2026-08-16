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

/** Rows the drain did not manage to deliver, re-read after every flush. */
const listPending = vi.fn<() => Promise<readonly unknown[]>>().mockResolvedValue([])

const engineRepos = {
  syncOutbox: { id: "outbox", listPending: () => listPending() },
  syncApply: { id: "apply" },
  syncState: { id: "state", getPushedOutboxId: async () => 7 },
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
    listPending.mockReset().mockResolvedValue([])
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

  it("pushes nothing in a region without a profile service", async () => {
    const result = await flushPendingOutbox({
      app: makeApp({ profileBaseUrl: undefined }),
      ownerId: "u-1",
      getLiveOwnerId: () => "u-1",
    })
    expect(pushLocal).not.toHaveBeenCalled()
    // Nothing was journaled anywhere else either, so an empty outbox is
    // genuinely nothing to lose.
    expect(result).toEqual({ stranded: false })
  })

  it("reports journaled rows as stranded where there is no profile service", async () => {
    listPending.mockResolvedValue([{ id: 9 }])
    const result = await flushPendingOutbox({
      app: makeApp({ profileBaseUrl: undefined }),
      ownerId: "u-1",
      getLiveOwnerId: () => "u-1",
    })
    // Never pushed anywhere and about to be wiped — the sign-out notice has to
    // say so rather than promise these rows come back (#1883).
    expect(result).toEqual({ stranded: true })
  })

  it("does nothing when the engine repositories were never wired", async () => {
    const app = makeApp({
      profileBaseUrl: "https://profile.example",
      repositories: () => ({ unitOfWork: engineRepos.unitOfWork }),
    })
    const result = await flushPendingOutbox({ app, ownerId: "u-1", getLiveOwnerId: () => "u-1" })
    expect(pushLocal).not.toHaveBeenCalled()
    expect(result).toEqual({ stranded: false })
  })

  it("reports a drained outbox as delivered", async () => {
    const result = await flushPendingOutbox({
      app: makeApp({ profileBaseUrl: "https://profile.example" }),
      ownerId: "u-1",
      getLiveOwnerId: () => "u-1",
    })
    expect(result).toEqual({ stranded: false })
    // Asked with the same scope the drain used, so the answer is exactly
    // "did the push leave anything behind".
    expect(listPending).toHaveBeenCalled()
  })

  it("reports rows the push could not deliver as stranded", async () => {
    pushLocal.mockRejectedValue(new Error("offline"))
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    listPending.mockResolvedValue([{ id: 3 }])

    const result = await flushPendingOutbox({
      app: makeApp({ profileBaseUrl: "https://profile.example" }),
      ownerId: "u-1",
      getLiveOwnerId: () => "u-1",
    })

    // A failed push no longer escapes as a rejection — what it cost the user
    // is carried in the result instead.
    expect(result).toEqual({ stranded: true })
  })

  it("claims no loss when the outbox cannot be re-read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    listPending.mockRejectedValue(new Error("db closed"))

    const result = await flushPendingOutbox({
      app: makeApp({ profileBaseUrl: "https://profile.example" }),
      ownerId: "u-1",
      getLiveOwnerId: () => "u-1",
    })

    // Unable to tell — better silent than alarming the user about a loss that
    // may not have happened.
    expect(result).toEqual({ stranded: false })
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
    ).resolves.toEqual({ stranded: false })
    expect(pushLocal).not.toHaveBeenCalled()
  })

  it("gives up on a push that never answers, so the sign-out can proceed", async () => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    pushLocal.mockReturnValue(new Promise(() => undefined))
    listPending.mockResolvedValue([{ id: 1 }])

    const flushed = flushPendingOutbox({
      app: makeApp({ profileBaseUrl: "https://profile.example" }),
      ownerId: "u-1",
      getLiveOwnerId: () => "u-1",
    })
    await vi.advanceTimersByTimeAsync(10_000)

    // The timeout resolves the sign-out rather than blocking it, and the rows
    // it abandoned are reported so the notice can name the loss.
    await expect(flushed).resolves.toEqual({ stranded: true })
    vi.useRealTimers()
  })
})
