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

vi.mock("@lectorium/lectorium.js", () => ({
  useLectorium: () => ({ activeServer: active, setActiveServer }),
}))
vi.mock("@lectorium/services/regionsRegistry.js", () => ({
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

  it("puts the active server back when every candidate failed", async () => {
    // Offline, all three fail — which says nothing about any of them. Leaving
    // the last one tried as active demotes a healthy region on the strength of
    // a dead radio, and it sticks: the watcher persists the choice, and the
    // startup probe checks the storage host, a different machine that answers
    // fine. The user can sit on the wrong region for days.
    active.value = B
    const fb = useServerFallback()

    await fb.tryServers(async () => {
      throw new Error("airplane mode")
    })

    expect(active.value).toEqual(B)
  })

  it("keeps the server that worked", async () => {
    // The other half of the same rule: a successful walk HAS learned
    // something, so the winner stays active.
    active.value = A
    const fb = useServerFallback()

    const result = await fb.tryServers(async () => {
      if (active.value.id !== "c") throw new Error("dead")
      return "bytes"
    })

    expect(result).toBe("bytes")
    expect(active.value).toEqual(C)
  })
})
