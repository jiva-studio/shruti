import { describe, it, expect, vi, beforeEach } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"

const A = { id: "a", urlTemplate: "https://a/{path}" } as CdnServer
const B = { id: "b", urlTemplate: "https://b/{path}" } as CdnServer
const C = { id: "c", urlTemplate: "https://c/{path}" } as CdnServer

// Mutable active server, mutated by setActiveServer like the real composition root.
const active = { value: A as CdnServer }
const setActiveServer = vi.fn((s: CdnServer) => {
  active.value = s
})

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ activeServer: active, setActiveServer }),
}))
vi.mock("@shruti/services/regionsRegistry.js", () => ({
  getRegions: () => [A, B, C],
}))

import { useServerFallback } from "../useServerFallback.js"

describe("useServerFallback.tryServers (transcript / opaque-URL failover)", () => {
  beforeEach(() => {
    active.value = A
    setActiveServer.mockClear()
  })

  it("lists the active server first, then the rest", () => {
    active.value = B
    expect(useServerFallback().candidates()).toEqual([B, A, C])
  })

  it("promotes each candidate before the attempt and returns the first success", async () => {
    const fb = useServerFallback()
    // The attempt reads the (just-promoted) active server, like a repo that
    // builds its URL from storagePublicUrl — succeeds only on B.
    const attempt = vi.fn(async () => {
      if (active.value.id !== "b") throw new Error(`dead: ${active.value.id}`)
      return "transcript-bytes"
    })

    const result = await fb.tryServers(attempt)

    expect(result).toBe("transcript-bytes")
    // Tried A (active) first, then promoted B before the winning attempt.
    expect(setActiveServer).toHaveBeenNthCalledWith(1, A)
    expect(setActiveServer).toHaveBeenNthCalledWith(2, B)
    expect(active.value).toEqual(B)
  })

  it("returns null when every candidate fails", async () => {
    const fb = useServerFallback()
    const attempt = vi.fn(async () => {
      throw new Error("all dead")
    })

    expect(await fb.tryServers(attempt)).toBeNull()
    // Rotated through all three candidates.
    expect(attempt).toHaveBeenCalledTimes(3)
  })
})
