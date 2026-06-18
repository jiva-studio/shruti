import { describe, it, expect, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"
import { createAssetFailover, extractAssetKey } from "../withAssetRegionFailover.js"

const A = { id: "a", urlTemplate: "https://a.cdn/{path}" } as CdnServer
const B = { id: "b", urlTemplate: "https://b.cdn/{path}" } as CdnServer
const C = { id: "c", urlTemplate: "https://c.cdn/{path}" } as CdnServer
const KEY = "public/collections/x/cover.jpg"
const URL_A = `https://a.cdn/${KEY}`

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

describe("createAssetFailover", () => {
  const deps = (fetchFn: (url: string) => Promise<string>, promote = vi.fn()) => ({
    getRegions: () => [A, B, C] as readonly CdnServer[],
    getActiveServer: () => A,
    promote,
    fetch: fetchFn,
  })

  it("serves the asset from the first other region that works and promotes it", async () => {
    const promote = vi.fn()
    const fetchFn = vi.fn(async (url: string) => {
      if (url.startsWith("https://b.cdn/")) return "blob:from-b"
      throw new Error(`dead: ${url}`)
    })
    const failover = createAssetFailover(deps(fetchFn, promote))

    expect(await failover(URL_A)).toBe("blob:from-b")
    // Re-targeted the SAME key onto region B's host, and promoted B.
    expect(fetchFn).toHaveBeenCalledWith(`https://b.cdn/${KEY}`)
    expect(promote).toHaveBeenCalledWith("b")
    // The dead active region is never re-tried.
    expect(fetchFn).not.toHaveBeenCalledWith(URL_A)
  })

  it("returns null and promotes nothing when no other region can serve it", async () => {
    const promote = vi.fn()
    const fetchFn = vi.fn(async () => {
      throw new Error("all dead")
    })
    const failover = createAssetFailover(deps(fetchFn, promote))

    expect(await failover(URL_A)).toBeNull()
    expect(promote).not.toHaveBeenCalled()
    // Tried B and C (not A).
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it("returns null without fetching for a url it can't re-target", async () => {
    const promote = vi.fn()
    const fetchFn = vi.fn(async () => "blob:x")
    const failover = createAssetFailover(deps(fetchFn, promote))

    expect(await failover("https://elsewhere/x.jpg")).toBeNull()
    expect(fetchFn).not.toHaveBeenCalled()
    expect(promote).not.toHaveBeenCalled()
  })
})
