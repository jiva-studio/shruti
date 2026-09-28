import { describe, expect, it, vi } from "vitest"
import { SERVERS } from "@lib/domain/servers.js"

async function freshRegistry() {
  vi.resetModules()
  return import("../regionsRegistry.js")
}

describe("bundled region seeds", () => {
  it("are all accepted by the registry's region validation", async () => {
    const reg = await freshRegistry()
    expect(reg.setRegions([...SERVERS])).toBe(true)
    expect(reg.getRegions().map((r) => r.id)).toEqual(SERVERS.map((r) => r.id))
  })

  it("name no store that no longer exists", () => {
    expect(SERVERS.map((r) => r.id)).toEqual(["global", "russia"])
  })

  it("serve the regional region's storage from its own host", () => {
    const regional = SERVERS.find((r) => r.id === "russia")
    expect(regional).toBeDefined()
    const storageHost = new URL(regional!.urlTemplate.replace("{path}", "public/config.json")).host
    expect(storageHost).toBe(new URL(regional!.chatBaseUrl).host)
    expect(regional!.urlTemplate).toBe(`${regional!.chatBaseUrl}/{path}`)
  })
})
