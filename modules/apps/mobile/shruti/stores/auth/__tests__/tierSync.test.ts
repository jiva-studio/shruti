import { describe, expect, it, vi } from "vitest"
import type { MeView } from "@ports/app/auth.js"
import { createTierSync, hasTierDiverged, raceTimeout, TIMED_OUT } from "../tierSync.js"

function makePort(me: MeView | null) {
  return {
    fetchMe: vi.fn(async () => me),
    refreshTokens: vi.fn(async () => undefined),
  }
}

describe("hasTierDiverged", () => {
  it("agrees when tier and expiry match", () => {
    expect(
      hasTierDiverged({ tier: "pro", tierExpiresAt: 10 }, { tier: "pro", tierExpiresAt: 10 })
    ).toBe(false)
  })

  it("catches a renewal, which moves only the expiry", () => {
    expect(
      hasTierDiverged({ tier: "pro", tierExpiresAt: 20 }, { tier: "pro", tierExpiresAt: 10 })
    ).toBe(true)
  })

  it("catches a tier flip", () => {
    expect(
      hasTierDiverged({ tier: "pro", tierExpiresAt: null }, { tier: "free", tierExpiresAt: null })
    ).toBe(true)
  })
})

describe("raceTimeout", () => {
  it("returns the value when it arrives first", async () => {
    expect(await raceTimeout(Promise.resolve("v"), 1000)).toBe("v")
  })

  it("reports a timeout instead of hanging", async () => {
    expect(await raceTimeout(new Promise(() => undefined), 1)).toBe(TIMED_OUT)
  })
})

describe("createTierSync", () => {
  it("refreshes the token when the server disagrees with the cached claim", async () => {
    const port = makePort({ tier: "pro", tierExpiresAt: null })
    const sync = createTierSync({
      port: () => port,
      cached: () => ({ tier: "free", tierExpiresAt: null }),
    })
    await sync.ensureFresh()
    expect(port.refreshTokens).toHaveBeenCalledOnce()
  })

  it("leaves the token alone when the server agrees", async () => {
    const port = makePort({ tier: "free", tierExpiresAt: null })
    const sync = createTierSync({
      port: () => port,
      cached: () => ({ tier: "free", tierExpiresAt: null }),
    })
    await sync.ensureFresh()
    expect(port.refreshTokens).not.toHaveBeenCalled()
  })

  it("skips a second probe within the freshness window", async () => {
    const port = makePort({ tier: "free", tierExpiresAt: null })
    const sync = createTierSync({
      port: () => port,
      cached: () => ({ tier: "free", tierExpiresAt: null }),
    })
    await sync.ensureFresh()
    await sync.ensureFresh()
    expect(port.fetchMe).toHaveBeenCalledOnce()
  })

  it("keeps the window open when the probe timed out", async () => {
    const port = {
      fetchMe: vi.fn(() => new Promise<MeView | null>(() => undefined)),
      refreshTokens: vi.fn(async () => undefined),
    }
    const sync = createTierSync({
      port: () => port,
      cached: () => ({ tier: "free", tierExpiresAt: null }),
    })
    await sync.ensureFresh({ timeoutMs: 1 })
    await sync.ensureFresh({ timeoutMs: 1 })
    expect(port.fetchMe).toHaveBeenCalledTimes(2)
  })

  it("does not throw when the probe fails", async () => {
    const port = {
      fetchMe: vi.fn(async () => {
        throw new Error("offline")
      }),
      refreshTokens: vi.fn(async () => undefined),
    }
    const sync = createTierSync({
      port: () => port,
      cached: () => ({ tier: "free", tierExpiresAt: null }),
    })
    await expect(sync.syncOnResume()).resolves.toBeUndefined()
    await expect(sync.ensureFresh()).resolves.toBeUndefined()
  })
})
