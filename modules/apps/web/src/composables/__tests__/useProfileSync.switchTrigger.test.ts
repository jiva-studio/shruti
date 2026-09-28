import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, ref } from "vue"
import { useProfileSync } from "../useProfileSync"

const session = ref<{ userId: string } | null>(null)
const ensureToken = vi.fn<() => Promise<string>>()

vi.mock("../useWebAuth", () => ({
  useWebAuth: () => ({
    session,
    signedIn: computed(() => session.value !== null),
    hydrate: () => undefined,
    ensureToken,
  }),
}))

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

const EMPTY_PULL = { changes: [], cursor: 0, has_more: false }

/** A fetch whose first pull hangs until released; every other call answers at once. */
function stubFetchWithHeldFirstPull(): { pulls: () => number; release: () => void } {
  let release: () => void = () => undefined
  let pulls = 0
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.endsWith("/pull")) {
        pulls++
        if (pulls === 1) {
          return new Promise<Response>((resolve) => (release = () => resolve(json(EMPTY_PULL))))
        }
        return Promise.resolve(json(EMPTY_PULL))
      }
      return Promise.resolve(json({ accepted: [], conflicts: [] }))
    })
  )
  return { pulls: () => pulls, release: () => release() }
}

function makeSync() {
  return useProfileSync({
    profileBaseUrl: "https://profile.test",
    storageKey: "t",
    snapshot: () => [],
    merge: vi.fn(),
  })
}

describe("useProfileSync triggers during a cycle", () => {
  beforeEach(() => {
    session.value = { userId: "A" }
    ensureToken.mockReset()
    ensureToken.mockImplementation(async () => `token-of-${session.value?.userId ?? "none"}`)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("runs a cycle for the new account requested while the old one was in flight", async () => {
    const net = stubFetchWithHeldFirstPull()
    const sync = makeSync()

    const first = sync.sync()
    await vi.waitFor(() => expect(net.pulls()).toBe(1))
    session.value = { userId: "B" }
    // The sign-in watcher asks for B's first cycle while A's is still running.
    await sync.sync()
    net.release()
    await first

    await vi.waitFor(() => expect(net.pulls()).toBe(2), { timeout: 500 })
    expect(sync.syncing.value).toBe(false)
  })

  it("runs a cycle for the new account after the old one aborts, unasked", async () => {
    const net = stubFetchWithHeldFirstPull()
    const sync = makeSync()

    const first = sync.sync()
    await vi.waitFor(() => expect(net.pulls()).toBe(1))
    session.value = { userId: "B" }
    net.release()
    await first

    await vi.waitFor(() => expect(net.pulls()).toBe(2), { timeout: 500 })
  })

  it("runs one more cycle, not one per trigger, after a busy cycle", async () => {
    const net = stubFetchWithHeldFirstPull()
    const sync = makeSync()

    const first = sync.sync()
    await vi.waitFor(() => expect(net.pulls()).toBe(1))
    await sync.sync()
    await sync.sync()
    net.release()
    await first

    await vi.waitFor(() => expect(net.pulls()).toBe(2), { timeout: 500 })
    await new Promise((r) => setTimeout(r, 20))
    expect(net.pulls()).toBe(2)
  })

  it("does not run again when nothing asked during the cycle", async () => {
    const net = stubFetchWithHeldFirstPull()
    const sync = makeSync()

    const first = sync.sync()
    await vi.waitFor(() => expect(net.pulls()).toBe(1))
    net.release()
    await first
    await new Promise((r) => setTimeout(r, 20))

    expect(net.pulls()).toBe(1)
  })
})
