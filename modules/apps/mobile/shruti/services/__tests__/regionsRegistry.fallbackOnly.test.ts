import { describe, expect, it, vi } from "vitest"
import { isFallbackOnly } from "@lib/domain/servers.js"

async function freshRegistry() {
  vi.resetModules()
  return import("../regionsRegistry.js")
}

/** A region exactly as a config.json published before `fallbackOnly` has it. */
const OLD_FORMAT = {
  id: "a",
  name: "A",
  urlTemplate: "https://a.example/{path}",
  shareAudioUrl: "https://api-a.example/share/audio/excerpts",
  shareVideoUrl: "https://api-a.example/share/video/reels",
  authBaseUrl: "https://api-a.example/auth",
  chatBaseUrl: "https://api-a.example",
}

const RESERVE = {
  ...OLD_FORMAT,
  id: "z",
  name: "Z",
  urlTemplate: "https://z.example/{path}",
  fallbackOnly: true,
}

describe("regionsRegistry with fallback-only regions", () => {
  it("accepts an old-format list", async () => {
    const reg = await freshRegistry()
    expect(reg.setRegions([OLD_FORMAT])).toBe(true)
    expect(isFallbackOnly(reg.findRegion("a")!)).toBe(false)
  })

  it("accepts a list containing a fallback-only region and keeps the flag", async () => {
    const reg = await freshRegistry()
    expect(reg.setRegions([OLD_FORMAT, RESERVE])).toBe(true)
    expect(reg.getRegions().map((r) => r.id)).toEqual(["a", "z"])
    expect(isFallbackOnly(reg.findRegion("z")!)).toBe(true)
  })

  it("still rejects a fallback-only region missing a field every region requires", async () => {
    const reg = await freshRegistry()
    const withoutAuth: Record<string, unknown> = { ...RESERVE }
    delete withoutAuth.authBaseUrl
    expect(reg.setRegions([OLD_FORMAT, withoutAuth])).toBe(false)
  })

  it("still rejects a fallback-only region whose template has no {path}", async () => {
    const reg = await freshRegistry()
    expect(reg.setRegions([OLD_FORMAT, { ...RESERVE, urlTemplate: "https://z.example/" }])).toBe(
      false
    )
  })

  it("treats any value other than true as a regular region", async () => {
    const reg = await freshRegistry()
    expect(reg.setRegions([{ ...RESERVE, fallbackOnly: "yes" }])).toBe(true)
    expect(isFallbackOnly(reg.findRegion("z")!)).toBe(false)
  })
})
