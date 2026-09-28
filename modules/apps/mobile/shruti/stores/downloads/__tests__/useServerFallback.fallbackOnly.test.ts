import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"

const A = { id: "a", urlTemplate: "https://a/{path}" } as CdnServer
const Z = { id: "z", urlTemplate: "https://z/{path}", fallbackOnly: true } as CdnServer
const B = { id: "b", urlTemplate: "https://b/{path}" } as CdnServer

const active = { value: A as CdnServer }
const setActiveServer = vi.fn((s: CdnServer) => {
  active.value = s
})

vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({ activeServer: active, setActiveServer }),
}))
vi.mock("@shruti/services/regionsRegistry.js", () => ({
  getRegions: () => [A, Z, B],
}))

import { useServerFallback } from "../useServerFallback.js"
import { decidePromotion } from "@usecases/downloads/downloadPolicy.js"

beforeEach(() => {
  active.value = A
  setActiveServer.mockClear()
})

describe("useServerFallback with a fallback-only region", () => {
  it("lists fallback-only regions after every regular one", () => {
    expect(
      useServerFallback()
        .candidates()
        .map((s) => s.id)
    ).toEqual(["a", "b", "z"])
  })

  it("keeps the active fallback-only region first while it is active", () => {
    active.value = Z
    expect(
      useServerFallback()
        .candidates()
        .map((s) => s.id)
    ).toEqual(["z", "a", "b"])
  })

  it("does not leave a fallback-only region active after it alone succeeded", async () => {
    const attempt = vi.fn(async () => {
      if (active.value.id !== "z") throw new Error(`dead: ${active.value.id}`)
      return "bytes"
    })

    expect(await useServerFallback().tryServers(attempt)).toBe("bytes")
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(active.value.id).toBe("a")
  })

  it("still promotes a regular region that succeeded", async () => {
    const attempt = vi.fn(async () => {
      if (active.value.id !== "b") throw new Error(`dead: ${active.value.id}`)
      return "bytes"
    })

    await useServerFallback().tryServers(attempt)
    expect(active.value.id).toBe("b")
  })
})

describe("decidePromotion", () => {
  it("promotes a regular region that delivered in place of the active one", () => {
    expect(decidePromotion("a", B)).toBe(true)
  })

  it("does not promote the region already active", () => {
    expect(decidePromotion("b", B)).toBe(false)
  })

  it("never promotes a fallback-only region", () => {
    expect(decidePromotion("a", Z)).toBe(false)
  })
})
