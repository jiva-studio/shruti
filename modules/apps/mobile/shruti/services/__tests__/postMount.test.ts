import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const restore = vi.fn(() => Promise.resolve())
const purchasesInit = vi.fn(() => Promise.resolve())
const ensureLoaded = vi.fn(() => Promise.resolve())

vi.mock("@shruti/stores/useAuthStore.js", () => ({
  useAuthStore: () => ({ restore }),
}))
vi.mock("@shruti/stores/usePurchasesStore.js", () => ({
  usePurchasesStore: () => ({ init: purchasesInit }),
}))
vi.mock("@shruti/stores/useLibraryLandingStore.js", () => ({
  useLibraryLandingStore: () => ({ ensureLoaded }),
}))
vi.mock("@shruti/services/monitoring/reportError.js", () => ({
  reportError: vi.fn(),
}))

const { runPostMountWork, __resetPostMountForTests } = await import("../postMount.js")

/**
 * `restore()` is the anonymous bootstrap — without it the run has no session and
 * every authenticated call 401s. It used to sit at the tail of `start()`, so any
 * rejection earlier in startup silently took it with it (#1738). It lives here
 * so the last-resort handler in `main.ts` runs it too.
 */
describe("runPostMountWork", () => {
  beforeEach(() => {
    __resetPostMountForTests()
    restore.mockClear()
    purchasesInit.mockClear()
    ensureLoaded.mockClear()
  })

  afterEach(() => {
    __resetPostMountForTests()
  })

  it("restores the session, the subscription and the landing data", () => {
    runPostMountWork()

    expect(restore).toHaveBeenCalledTimes(1)
    expect(purchasesInit).toHaveBeenCalledTimes(1)
    expect(ensureLoaded).toHaveBeenCalledTimes(1)
  })

  it("runs once even though start() and its catch may both reach it", () => {
    runPostMountWork()
    runPostMountWork()

    expect(restore).toHaveBeenCalledTimes(1)
  })

  it("still restores the session when a store rejects", async () => {
    purchasesInit.mockImplementationOnce(() => Promise.reject(new Error("no store")))

    runPostMountWork()
    await Promise.resolve()

    expect(restore).toHaveBeenCalledTimes(1)
  })
})
