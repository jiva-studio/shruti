// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"

const KEY = "CapacitorStorage.dev.subscriptionOverride"
const LEGACY_FREE = "CapacitorStorage.e2e.forceFreeTier"

async function freshModule() {
  vi.resetModules()
  return import("../devSubscription.js")
}

describe("the dev subscription override as it is stored", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("starts from what the build does naturally", async () => {
    const mod = await freshModule()

    expect(mod.devSubscriptionOverride.value).toBe("default")
  })

  it("picks up a stored choice at boot", async () => {
    localStorage.setItem(KEY, "pro")

    const mod = await freshModule()

    expect(mod.devSubscriptionOverride.value).toBe("pro")
  })

  it("ignores a stored value that names no tier", async () => {
    localStorage.setItem(KEY, "platinum")

    const mod = await freshModule()

    expect(mod.devSubscriptionOverride.value).toBe("default")
  })

  it("reads the suite's force-free flag as the free tier", async () => {
    localStorage.setItem(LEGACY_FREE, "1")
    localStorage.setItem(KEY, "pro")

    const mod = await freshModule()

    expect(mod.devSubscriptionOverride.value).toBe("free")
  })

  it("persists a chosen tier for the next boot", async () => {
    const mod = await freshModule()

    mod.setDevSubscriptionOverride("free")

    expect(mod.devSubscriptionOverride.value).toBe("free")
    expect(localStorage.getItem(KEY)).toBe("free")
    expect((await freshModule()).devSubscriptionOverride.value).toBe("free")
  })

  it("forgets the choice when it goes back to the build default", async () => {
    const mod = await freshModule()
    mod.setDevSubscriptionOverride("pro")

    mod.setDevSubscriptionOverride("default")

    expect(localStorage.getItem(KEY)).toBeNull()
    expect(mod.devSubscriptionOverride.value).toBe("default")
  })

  it("keeps the chosen tier for this session when storage refuses the write", async () => {
    const mod = await freshModule()
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded")
    })

    mod.setDevSubscriptionOverride("free")

    expect(mod.devSubscriptionOverride.value).toBe("free")
    setItem.mockRestore()
  })
})
