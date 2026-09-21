import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"

async function freshRegistry() {
  vi.resetModules()
  return import("../regionsRegistry.js")
}

function region(id: string): CdnServer {
  return {
    id,
    name: id,
    urlTemplate: `https://${id}.example/{path}`,
    shareAudioUrl: `https://${id}.example/share/audio/excerpts`,
    shareVideoUrl: `https://${id}.example/share/video/reels`,
    authBaseUrl: `https://${id}.example/auth`,
    chatBaseUrl: `https://${id}.example`,
  }
}

describe("regionsRegistry — asset URLs follow the active region", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("falls back to the first region before one is chosen", async () => {
    const reg = await freshRegistry()
    reg.setRegions([region("europe"), region("asia")])

    expect(reg.activeRegion()?.id).toBe("europe")
    expect(reg.resolveAssetUrl("covers/a.jpg")).toBe("https://europe.example/covers/a.jpg")
  })

  it("follows a promotion to another region", async () => {
    const reg = await freshRegistry()
    reg.setRegions([region("europe"), region("asia")])

    reg.setActiveRegionId("asia")

    expect(reg.activeRegion()?.id).toBe("asia")
    expect(reg.resolveAssetUrl("covers/a.jpg")).toBe("https://asia.example/covers/a.jpg")
  })

  it("falls back to the first region when the active id is no longer listed", async () => {
    const reg = await freshRegistry()
    reg.setRegions([region("europe"), region("asia")])
    reg.setActiveRegionId("asia")

    reg.setRegions([region("europe")])

    expect(reg.activeRegion()?.id).toBe("europe")
  })

  it("resolves nothing for an empty key", async () => {
    const reg = await freshRegistry()

    expect(reg.resolveAssetUrl(undefined)).toBeUndefined()
    expect(reg.resolveAssetUrl("")).toBeUndefined()
  })

  it("keeps the fresh list when persisting it fails", async () => {
    const reg = await freshRegistry()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    await reg.hydrateRegions({
      get: async () => null,
      set: async () => {
        throw new Error("preferences unavailable")
      },
      remove: async () => {},
    })

    expect(reg.setRegions([region("asia")])).toBe(true)
    expect(reg.getRegions().map((r) => r.id)).toEqual(["asia"])
  })
})
