import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Stub the Capacitor Device plugin so the lang signal can be driven by
// the deps override and never reaches the native bridge.
vi.mock("@capacitor/device", () => ({
  Device: {
    getLanguageCode: vi.fn().mockResolvedValue({ value: "en" }),
  },
}))

import { detectHomeRegion, welcomeRegion } from "../regionDetect.js"

const WHOAMI_URL = "https://global.example/auth/whoami"

describe("detectHomeRegion", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("signal 1 — Russian timezone short-circuits without touching lang or IP", async () => {
    const lang = vi.fn().mockResolvedValue("en")
    const region = await detectHomeRegion({
      whoamiUrl: WHOAMI_URL,
      fetch: fetchMock as unknown as typeof fetch,
      resolvedTimezone: () => "Europe/Moscow",
      deviceLanguage: lang,
    })
    expect(region).toBe("russia")
    expect(lang).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("signal 2 — non-RU TZ + ru lang → russia, no IP probe", async () => {
    const region = await detectHomeRegion({
      whoamiUrl: WHOAMI_URL,
      fetch: fetchMock as unknown as typeof fetch,
      resolvedTimezone: () => "America/New_York",
      deviceLanguage: async () => "ru",
    })
    expect(region).toBe("russia")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("signal 3 — non-RU TZ + en lang + IP RU → russia", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ country: "RU" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    const region = await detectHomeRegion({
      whoamiUrl: WHOAMI_URL,
      fetch: fetchMock as unknown as typeof fetch,
      resolvedTimezone: () => "America/New_York",
      deviceLanguage: async () => "en",
    })
    expect(region).toBe("russia")
    expect(fetchMock).toHaveBeenCalledWith(WHOAMI_URL, expect.any(Object))
  })

  it("all three negative → global", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ country: "US" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    const region = await detectHomeRegion({
      whoamiUrl: WHOAMI_URL,
      fetch: fetchMock as unknown as typeof fetch,
      resolvedTimezone: () => "America/New_York",
      deviceLanguage: async () => "en",
    })
    expect(region).toBe("global")
  })

  it("IP probe network error → falls back to global (does not throw)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
    const region = await detectHomeRegion({
      whoamiUrl: WHOAMI_URL,
      fetch: fetchMock as unknown as typeof fetch,
      resolvedTimezone: () => "America/New_York",
      deviceLanguage: async () => "en",
    })
    expect(region).toBe("global")
  })

  it("IP probe empty country → global", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ country: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    const region = await detectHomeRegion({
      whoamiUrl: WHOAMI_URL,
      fetch: fetchMock as unknown as typeof fetch,
      resolvedTimezone: () => "America/New_York",
      deviceLanguage: async () => "en",
    })
    expect(region).toBe("global")
  })

  it("IP probe 5xx → global", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    const region = await detectHomeRegion({
      whoamiUrl: WHOAMI_URL,
      fetch: fetchMock as unknown as typeof fetch,
      resolvedTimezone: () => "America/New_York",
      deviceLanguage: async () => "en",
    })
    expect(region).toBe("global")
  })

  it("Intl throws → continues to lang/IP without crashing", async () => {
    const region = await detectHomeRegion({
      whoamiUrl: WHOAMI_URL,
      fetch: fetchMock as unknown as typeof fetch,
      resolvedTimezone: () => {
        throw new Error("Intl not available")
      },
      deviceLanguage: async () => "ru",
    })
    expect(region).toBe("russia")
  })

  it("Device.getLanguageCode rejection falls through to IP probe", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ country: "RU" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    const region = await detectHomeRegion({
      whoamiUrl: WHOAMI_URL,
      fetch: fetchMock as unknown as typeof fetch,
      resolvedTimezone: () => "America/New_York",
      deviceLanguage: async () => {
        throw new Error("plugin missing")
      },
    })
    expect(region).toBe("russia")
    expect(fetchMock).toHaveBeenCalled()
  })
})

describe("welcomeRegion", () => {
  const KEY = "preferredServerId"

  function makePrefs(initial: Record<string, string> = {}) {
    const store = new Map<string, string>(Object.entries(initial))
    return {
      store,
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        store.set(k, v)
      }),
    }
  }

  it("first launch — calls detect, persists detected region", async () => {
    const prefs = makePrefs()
    const detect = vi.fn().mockResolvedValue("russia")
    const region = await welcomeRegion({ prefs, detect, storageKey: KEY })
    expect(region).toBe("russia")
    expect(detect).toHaveBeenCalledOnce()
    expect(prefs.set).toHaveBeenCalledWith(KEY, "russia")
    expect(prefs.store.get(KEY)).toBe("russia")
  })

  it("returning launch — honors stored preference, does NOT call detect", async () => {
    const prefs = makePrefs({ [KEY]: "russia" })
    const detect = vi.fn().mockResolvedValue("global")
    const region = await welcomeRegion({ prefs, detect, storageKey: KEY })
    expect(region).toBe("russia")
    expect(detect).not.toHaveBeenCalled()
    expect(prefs.set).not.toHaveBeenCalled()
  })

  it("stored 'global' wins over detect 'russia'", async () => {
    const prefs = makePrefs({ [KEY]: "global" })
    const detect = vi.fn().mockResolvedValue("russia")
    const region = await welcomeRegion({ prefs, detect, storageKey: KEY })
    expect(region).toBe("global")
    expect(detect).not.toHaveBeenCalled()
  })
})
