import { describe, expect, it, vi } from "vitest"
import type { IRemoteFilesStorage } from "@kit/infra"
import { prewarmImageCache } from "../prewarmImageCache.js"

function makeStorage(overrides: Partial<IRemoteFilesStorage> = {}): IRemoteFilesStorage {
  return {
    get: vi.fn(async (url: string) => url),
    getJson: vi.fn(),
    has: vi.fn(async () => false),
    delete: vi.fn(),
    clearAll: vi.fn(),
    ...overrides,
  } as unknown as IRemoteFilesStorage
}

describe("prewarmImageCache", () => {
  it("fetches each uncached url once", async () => {
    const storage = makeStorage()
    await prewarmImageCache(storage, ["/a.webp", "/b.webp"])
    expect(storage.get).toHaveBeenCalledTimes(2)
    expect(storage.get).toHaveBeenCalledWith("/a.webp")
    expect(storage.get).toHaveBeenCalledWith("/b.webp")
  })

  it("dedupes and drops falsy urls", async () => {
    const storage = makeStorage()
    await prewarmImageCache(storage, ["/a.webp", undefined, "/a.webp", ""])
    expect(storage.get).toHaveBeenCalledTimes(1)
    expect(storage.get).toHaveBeenCalledWith("/a.webp")
  })

  it("skips urls already in the cache", async () => {
    const storage = makeStorage({ has: vi.fn(async (u: string) => u === "/cached.webp") })
    await prewarmImageCache(storage, ["/cached.webp", "/fresh.webp"])
    expect(storage.get).toHaveBeenCalledTimes(1)
    expect(storage.get).toHaveBeenCalledWith("/fresh.webp")
  })

  it("revokes blob: urls so web object URLs do not leak", async () => {
    const revoke = vi.fn()
    vi.stubGlobal("URL", { ...URL, revokeObjectURL: revoke })
    const storage = makeStorage({ get: vi.fn(async () => "blob:abc") })
    await prewarmImageCache(storage, ["/a.webp"])
    expect(revoke).toHaveBeenCalledWith("blob:abc")
    vi.unstubAllGlobals()
  })

  it("keeps going when one url throws", async () => {
    const get = vi.fn(async (u: string) => {
      if (u === "/bad.webp") throw new Error("network")
      return u
    })
    const storage = makeStorage({ get })
    await expect(prewarmImageCache(storage, ["/bad.webp", "/good.webp"])).resolves.toBeUndefined()
    expect(get).toHaveBeenCalledWith("/good.webp")
  })
})
