import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// In-memory Preferences mock — same shape as the migrateToRegion test.
const memPrefs = new Map<string, string>()
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    async get({ key }: { key: string }) {
      return { value: memPrefs.has(key) ? memPrefs.get(key)! : null }
    },
    async set({ key, value }: { key: string; value: string }) {
      memPrefs.set(key, value)
    },
    async remove({ key }: { key: string }) {
      memPrefs.delete(key)
    },
  },
}))

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android" },
}))
vi.mock("@capacitor/device", () => ({
  Device: { getId: () => Promise.resolve({ identifier: "device-stub" }) },
}))
vi.mock("@capgo/capacitor-social-login", () => ({
  SocialLogin: {
    initialize: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  },
}))

import { useCapacitorAuth } from "../useCapacitorAuth.js"

function makeAdapter(overrides: { resolveAuthBaseUrl?: (id: string) => string } = {}) {
  return useCapacitorAuth({
    baseUrl: () => "https://current.example/auth",
    resolveAuthBaseUrl:
      overrides.resolveAuthBaseUrl ??
      ((regionId: string) => {
        if (regionId === "russia") return "https://russia.example/auth"
        if (regionId === "global") return "https://global.example/auth"
        throw new Error(`unknown region: ${regionId}`)
      }),
    currentRegionId: () => "global",
    googleWebClientId: "g-web",
    googleIOSClientId: "g-ios",
  })
}

describe("useCapacitorAuth.lookupAccount", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    memPrefs.clear()
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("200 with exists:true → returned shape", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ exists: true, anonymous: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    const auth = makeAdapter()
    const result = await auth.lookupAccount("russia", "google", "id-token-xyz")
    expect(result).toEqual({ exists: true, anonymous: false })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://russia.example/auth/signin/google")
    expect((init as RequestInit).method).toBe("POST")
    const headers = new Headers((init as RequestInit).headers as HeadersInit)
    expect(headers.get("X-Lookup-Only")).toBe("1")
  })

  it("200 with exists:false → returned shape", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ exists: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    const auth = makeAdapter()
    const result = await auth.lookupAccount("russia", "google", "id-token")
    expect(result).toEqual({ exists: false, anonymous: false })
  })

  it("404 from /signin → maps to {exists: false, anonymous: false}", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "account_not_found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    )
    const auth = makeAdapter()
    const result = await auth.lookupAccount("russia", "google", "id-token")
    expect(result).toEqual({ exists: false, anonymous: false })
  })

  it("5xx → null (uncertainty — caller surfaces dup-risk warning)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    const auth = makeAdapter()
    const result = await auth.lookupAccount("russia", "google", "id-token")
    expect(result).toBeNull()
  })

  it("network error → null", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
    const auth = makeAdapter()
    const result = await auth.lookupAccount("russia", "google", "id-token")
    expect(result).toBeNull()
  })

  it("malformed body → null", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("not json at all", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    )
    const auth = makeAdapter()
    const result = await auth.lookupAccount("russia", "google", "id-token")
    expect(result).toBeNull()
  })

  it("200 with body missing 'exists' boolean → null", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ something: "else" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
    const auth = makeAdapter()
    const result = await auth.lookupAccount("russia", "google", "id-token")
    expect(result).toBeNull()
  })

  it("unknown region id (resolveAuthBaseUrl throws) → null, no fetch", async () => {
    const auth = makeAdapter({
      resolveAuthBaseUrl: () => {
        throw new Error("unknown region")
      },
    })
    const result = await auth.lookupAccount("atlantis", "google", "id-token")
    expect(result).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("aborts on 3s timeout → null", async () => {
    // Simulate a fetch that rejects when the AbortController fires. The
    // 3s timer is set inside lookupAccount; we can't sit through it in a
    // test, so we mock fetch to inspect the abort signal and reject
    // synchronously when invoked, then resolve after `signal.aborted`.
    fetchMock.mockImplementationOnce(async (_url: string, init?: RequestInit) => {
      // Verify the adapter is wiring an abort signal.
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      // Pretend the network never responded — throw a DOMException-like
      // abort error after a tick.
      throw Object.assign(new Error("aborted"), { name: "AbortError" })
    })
    const auth = makeAdapter()
    const result = await auth.lookupAccount("russia", "google", "id-token")
    expect(result).toBeNull()
  })
})
