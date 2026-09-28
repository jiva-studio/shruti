import { describe, expect, it, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"
import { createAssetFailover } from "../withAssetRegionFailover.js"

const A = { id: "a", urlTemplate: "https://a.cdn/{path}" } as CdnServer
const Z = { id: "z", urlTemplate: "https://z.cdn/{path}", fallbackOnly: true } as CdnServer
const KEY = "public/collections/x/cover.jpg"

describe("createAssetFailover with a fallback-only region", () => {
  it("serves the asset from a fallback-only region without promoting it", async () => {
    const promote = vi.fn()
    const failover = createAssetFailover({
      getRegions: () => [A, Z],
      getActiveServer: () => A,
      promote,
      fetch: async (url) => {
        if (url.startsWith("https://z.cdn/")) return "blob:from-z"
        throw new Error(`dead: ${url}`)
      },
    })

    expect(await failover(`https://a.cdn/${KEY}`)).toBe("blob:from-z")
    expect(promote).not.toHaveBeenCalled()
  })
})
