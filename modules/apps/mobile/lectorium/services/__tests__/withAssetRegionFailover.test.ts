import { describe, it, expect, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"
import type { IRemoteFilesStorage } from "@ports/app/index.js"
import { extractAssetKey, withAssetRegionFailover } from "../withAssetRegionFailover.js"

const A = { id: "a", urlTemplate: "https://a.cdn/{path}" } as CdnServer
const B = { id: "b", urlTemplate: "https://b.cdn/{path}" } as CdnServer
const KEY = "public/collections/x/cover.jpg"
const URL_A = `https://a.cdn/${KEY}`
const URL_B = `https://b.cdn/${KEY}`

function makeStorage(get: IRemoteFilesStorage["get"]): IRemoteFilesStorage {
  return {
    get,
    getJson: vi.fn(),
    has: vi.fn(),
    delete: vi.fn(),
    clearAll: vi.fn(),
  }
}

describe("extractAssetKey", () => {
  it("strips the active region template to recover the object key", () => {
    expect(extractAssetKey(URL_A, A.urlTemplate)).toBe(KEY)
  })
  it("returns null for a url not built from the template", () => {
    expect(extractAssetKey("https://elsewhere/x.jpg", A.urlTemplate)).toBeNull()
  })
  it("handles a template with a suffix after {path}", () => {
    expect(extractAssetKey("https://c.cdn/k.jpg?v=1", "https://c.cdn/{path}?v=1")).toBe("k.jpg")
  })
})

describe("withAssetRegionFailover", () => {
  const deps = (promote = vi.fn()) => ({
    getRegions: () => [A, B] as readonly CdnServer[],
    getActiveServer: () => A,
    promote,
  })

  it("passes through when the active region serves the asset (no failover)", async () => {
    const promote = vi.fn()
    const inner = makeStorage(vi.fn().mockResolvedValue("blob:ok"))
    const fs = withAssetRegionFailover(inner, deps(promote))
    expect(await fs.get(URL_A)).toBe("blob:ok")
    expect(inner.get).toHaveBeenCalledTimes(1)
    expect(promote).not.toHaveBeenCalled()
  })

  it("fails over to another region and promotes it when the active one is dead", async () => {
    const promote = vi.fn()
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error("region a down")) // active
      .mockResolvedValueOnce("blob:from-b") // region b
    const fs = withAssetRegionFailover(makeStorage(get), deps(promote))

    expect(await fs.get(URL_A)).toBe("blob:from-b")
    // Retried the SAME key against region B's host…
    expect(get).toHaveBeenNthCalledWith(2, URL_B)
    // …and promoted B so streaming/transcripts/other covers follow.
    expect(promote).toHaveBeenCalledWith("b")
  })

  it("throws the original error and promotes nothing when every region fails", async () => {
    const promote = vi.fn()
    const first = new Error("region a down")
    const get = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(new Error("b down"))
    const fs = withAssetRegionFailover(makeStorage(get), deps(promote))

    await expect(fs.get(URL_A)).rejects.toBe(first)
    expect(promote).not.toHaveBeenCalled()
  })

  it("doesn't fail over a url it can't re-target (foreign host)", async () => {
    const promote = vi.fn()
    const foreign = "https://elsewhere/x.jpg"
    const err = new Error("nope")
    const get = vi.fn().mockRejectedValueOnce(err)
    const fs = withAssetRegionFailover(makeStorage(get), deps(promote))

    await expect(fs.get(foreign)).rejects.toBe(err)
    expect(get).toHaveBeenCalledTimes(1) // no region attempts
    expect(promote).not.toHaveBeenCalled()
  })
})
