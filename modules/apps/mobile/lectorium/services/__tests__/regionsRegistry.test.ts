import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CdnServer } from "@lib/domain/servers.js"
import type { IPreferences } from "@ports/app/index.js"

// The registry is a module singleton; reset modules between tests so each
// starts from the bundled bootstrap seed.
async function freshRegistry() {
  vi.resetModules()
  return import("../regionsRegistry.js")
}

function fakePreferences(initial: Record<string, string> = {}): IPreferences & {
  store: Record<string, string>
} {
  const store: Record<string, string> = { ...initial }
  return {
    store,
    get: (k) => Promise.resolve(k in store ? store[k]! : null),
    set: (k, v) => {
      store[k] = v
      return Promise.resolve()
    },
    remove: (k) => {
      delete store[k]
      return Promise.resolve()
    },
  }
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

describe("regionsRegistry", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("seeds from the bundled SERVERS list", async () => {
    const reg = await freshRegistry()
    const ids = reg.getRegions().map((r) => r.id)
    expect(ids).toContain("global")
    expect(ids.length).toBeGreaterThan(0)
  })

  it("setRegions replaces the list and reports applied", async () => {
    const reg = await freshRegistry()
    await reg.hydrateRegions(fakePreferences())
    const ok = reg.setRegions([region("europe"), region("asia")])
    expect(ok).toBe(true)
    expect(reg.getRegions().map((r) => r.id)).toEqual(["europe", "asia"])
    expect(reg.findRegion("asia")?.id).toBe("asia")
  })

  it("setRegions persists the applied list", async () => {
    const reg = await freshRegistry()
    const prefs = fakePreferences()
    await reg.hydrateRegions(prefs)
    reg.setRegions([region("europe")])
    const raw = prefs.store[reg.REGIONS_KEY]
    expect(raw).toBeDefined()
    expect(JSON.parse(raw!)[0].id).toBe("europe")
  })

  it("setRegions ignores an empty list (anti-brick)", async () => {
    const reg = await freshRegistry()
    const before = reg.getRegions()
    expect(reg.setRegions([])).toBe(false)
    expect(reg.getRegions()).toEqual(before)
  })

  it("setRegions ignores malformed entries", async () => {
    const reg = await freshRegistry()
    const before = reg.getRegions()
    // urlTemplate without the {path} placeholder
    const bad = { ...region("x"), urlTemplate: "https://x.example/no-placeholder" }
    expect(reg.setRegions([bad])).toBe(false)
    // missing field
    expect(reg.setRegions([{ id: "y", name: "Y" }])).toBe(false)
    // not an array
    expect(reg.setRegions({ id: "z" })).toBe(false)
    expect(reg.getRegions()).toEqual(before)
  })

  it("hydrateRegions adopts a valid persisted list", async () => {
    const reg = await freshRegistry()
    const prefs = fakePreferences({ [reg.REGIONS_KEY]: JSON.stringify([region("europe")]) })
    await reg.hydrateRegions(prefs)
    expect(reg.getRegions().map((r) => r.id)).toEqual(["europe"])
  })

  it("hydrateRegions keeps the bootstrap on an invalid persisted blob", async () => {
    const reg = await freshRegistry()
    const before = reg.getRegions()
    const prefs = fakePreferences({ [reg.REGIONS_KEY]: "[]" })
    await reg.hydrateRegions(prefs)
    expect(reg.getRegions()).toEqual(before)
  })

  it("hydrateRegions tolerates corrupt JSON", async () => {
    const reg = await freshRegistry()
    const before = reg.getRegions()
    const prefs = fakePreferences({ [reg.REGIONS_KEY]: "{not json" })
    await reg.hydrateRegions(prefs)
    expect(reg.getRegions()).toEqual(before)
  })
})
