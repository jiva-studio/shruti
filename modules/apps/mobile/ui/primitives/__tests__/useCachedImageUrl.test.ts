// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { createApp, defineComponent, h, ref, type Ref } from "vue"
import type { IRemoteFilesStorage } from "@kit/infra"
import { useCachedImageUrl, type UseCachedImageUrlReturn } from "../useCachedImageUrl.js"
import { FILES_STORAGE_KEY } from "../filesStorageKey.js"

function makeStorage(get: IRemoteFilesStorage["get"]): IRemoteFilesStorage {
  return {
    get,
    getJson: vi.fn(),
    has: vi.fn(async () => false),
    delete: vi.fn(),
    clearAll: vi.fn(),
  } as unknown as IRemoteFilesStorage
}

/**
 * Mount a throwaway host component that provides `storage` and runs the
 * composable, so `inject` / `watch` / `onUnmounted` have a real component
 * context. Returns the composable handle plus an `unmount`.
 */
function mountComposable(
  url: Ref<string | undefined>,
  storage: IRemoteFilesStorage | null
): { api: UseCachedImageUrlReturn; unmount: () => void } {
  let api!: UseCachedImageUrlReturn
  const Host = defineComponent({
    setup() {
      api = useCachedImageUrl(url)
      return () => h("div")
    },
  })
  const app = createApp(Host)
  if (storage) app.provide(FILES_STORAGE_KEY, storage)
  const root = document.createElement("div")
  app.mount(root)
  return { api, unmount: () => app.unmount() }
}

describe("useCachedImageUrl", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves the cached url on the happy path (no retry)", async () => {
    const get = vi.fn(async () => "blob:cached")
    const { api } = mountComposable(ref("/cover.jpg"), makeStorage(get))
    await vi.runAllTimersAsync()
    expect(api.src.value).toBe("blob:cached")
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("retries the cached resolve on rejection, then succeeds", async () => {
    let n = 0
    const get = vi.fn(async () => {
      n++
      if (n < 2) throw new Error("flaky")
      return "blob:recovered"
    })
    const { api } = mountComposable(ref("/cover.jpg"), makeStorage(get))
    await vi.runAllTimersAsync()
    expect(get).toHaveBeenCalledTimes(2)
    expect(api.src.value).toBe("blob:recovered")
  })

  it("falls back to the raw url after exhausting attempts", async () => {
    const get = vi.fn(async () => {
      throw new Error("always fails")
    })
    const { api } = mountComposable(ref("/cover.jpg"), makeStorage(get))
    await vi.runAllTimersAsync()
    // MAX_ATTEMPTS = 3 cached-resolve tries, then the raw url.
    expect(get).toHaveBeenCalledTimes(3)
    expect(api.src.value).toBe("/cover.jpg")
  })

  it("retry() re-resolves when a successfully-resolved src fails to render", async () => {
    let n = 0
    const get = vi.fn(async () => {
      n++
      // The cached resolve SUCCEEDS, but the resolved url renders a broken
      // image; the <img> @error → retry() must re-resolve to a fresh src.
      return n === 1 ? "blob:broken" : "blob:good"
    })
    const { api } = mountComposable(ref("/cover.jpg"), makeStorage(get))
    await vi.runAllTimersAsync()
    expect(api.src.value).toBe("blob:broken")
    // Simulate the <img> firing `error` on the resolved-but-broken src.
    api.retry()
    await vi.runAllTimersAsync()
    expect(get).toHaveBeenCalledTimes(2)
    expect(api.src.value).toBe("blob:good")
  })

  it("retry() gives up once attempts are exhausted (no infinite loop)", async () => {
    const get = vi.fn(async () => {
      throw new Error("dead link")
    })
    const { api } = mountComposable(ref("/cover.jpg"), makeStorage(get))
    await vi.runAllTimersAsync()
    expect(api.src.value).toBe("/cover.jpg")
    const callsBefore = get.mock.calls.length
    // Simulate repeated <img> error events — must not re-fetch.
    api.retry()
    api.retry()
    await vi.runAllTimersAsync()
    expect(get.mock.calls.length).toBe(callsBefore)
  })

  it("cancels in-flight retries when the url changes", async () => {
    const url = ref<string | undefined>("/a.jpg")
    const get = vi.fn(async (u: string) => {
      if (u === "/a.jpg") throw new Error("a fails")
      return "blob:b"
    })
    const { api } = mountComposable(url, makeStorage(get))
    // Let the initial /a.jpg attempt reject and schedule its backoff, then flip
    // the url mid-backoff so the stale retry must be cancelled.
    await vi.advanceTimersByTimeAsync(0)
    url.value = "/b.jpg"
    await vi.runAllTimersAsync()
    // The new url wins; stale /a.jpg retries don't clobber it.
    expect(api.src.value).toBe("blob:b")
  })

  it("loads the raw url directly when no storage is wired", async () => {
    const { api } = mountComposable(ref("/cover.jpg"), null)
    await vi.runAllTimersAsync()
    expect(api.src.value).toBe("/cover.jpg")
  })
})
