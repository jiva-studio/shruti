import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

// SocialLogin.login returns a Google id-token by default; individual
// tests can override the mock. Hoisted so vi.mock's factory (hoisted
// before any other top-level code) can close over the same reference.
const { socialLoginMock } = vi.hoisted(() => ({
  socialLoginMock: vi.fn(),
}))
vi.mock("@capgo/capacitor-social-login", () => ({
  SocialLogin: {
    initialize: vi.fn(),
    login: socialLoginMock,
    logout: vi.fn(),
  },
}))

import { useCapacitorAuth } from "../useCapacitorAuth.js"

function b64url(input: string): string {
  return btoa(input).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}
function makeAccessJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims)
  )}.signature`
}

const futureExp = Math.floor(Date.now() / 1000) + 3600

function tokenResponse(): Response {
  const accessTok = makeAccessJwt({ exp: futureExp, tier: "free", quota_id: "q1" })
  return new Response(
    JSON.stringify({
      accessToken: accessTok,
      refreshToken: "r-1",
      userId: "u-1",
      anonymous: false,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )
}

function meResponse(): Response {
  return new Response(
    JSON.stringify({
      userId: "u-1",
      email: null,
      name: null,
      pictureUrl: null,
      anonymous: false,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )
}

// Single-region adapter — no proactive cross-region probe; signin goes
// straight to the only region the build knows about.
function makeAdapterSingleRegion() {
  return useCapacitorAuth({
    baseUrl: () => "https://current.example/auth",
    resolveAuthBaseUrl: (id: string) => `https://${id}.example/auth`,
    currentRegionId: () => "global",
    googleWebClientId: "g-web",
    googleIOSClientId: "g-ios",
  })
}

// Multi-region adapter — wires `getRegions` + `setActiveServerById` so the
// adapter can probe and silent-switch. The `setActive` spy lets each test
// assert which region the signin landed on.
function makeAdapterMultiRegion(opts: {
  regions: string[]
  current: string
  setActive: (id: string) => void
}) {
  return useCapacitorAuth({
    baseUrl: () => `https://${opts.current}.example/auth`,
    resolveAuthBaseUrl: (id: string) => `https://${id}.example/auth`,
    currentRegionId: () => opts.current,
    getRegions: () => opts.regions.map((id) => ({ id })),
    setActiveServerById: opts.setActive,
    googleWebClientId: "g-web",
    googleIOSClientId: "g-ios",
  })
}

describe("useCapacitorAuth signin — proactive cross-region probe", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    memPrefs.clear()
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    socialLoginMock.mockResolvedValue({
      provider: "google",
      result: { responseType: "online", idToken: "stub-id-token" },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("single-region: skips probe entirely, goes straight to signin on current", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(meResponse())
    const auth = makeAdapterSingleRegion()
    const session = await auth.signInWithGoogle()
    expect(session?.userId).toBe("u-1")
    // Just the real signin + /auth/me. No X-Lookup-Only probe call.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, init] = fetchMock.mock.calls[0]!
    const headers = new Headers((init as RequestInit).headers as HeadersInit)
    expect(headers.get("X-Lookup-Only")).toBeNull()
  })

  it("multi-region: account on other region → silent switch + signin there", async () => {
    const switchCalls: string[] = []
    fetchMock
      // probe global → not found (404 is treated by lookupAccount as exists:false)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "account_not_found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      )
      // probe russia → hit
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, anonymous: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      // real signin (on russia after switch)
      .mockResolvedValueOnce(tokenResponse())
      // /auth/me after commit
      .mockResolvedValueOnce(meResponse())
    const auth = makeAdapterMultiRegion({
      regions: ["global", "russia"],
      current: "global",
      setActive: (id) => switchCalls.push(id),
    })
    const session = await auth.signInWithGoogle()
    expect(session?.userId).toBe("u-1")
    expect(switchCalls).toEqual(["russia"])
    // Probe URLs hit both regions
    const probeUrls = fetchMock.mock.calls.slice(0, 2).map((c) => c[0])
    expect(probeUrls.sort()).toEqual([
      "https://global.example/auth/signin/google",
      "https://russia.example/auth/signin/google",
    ])
    // First two carry X-Lookup-Only, third (real signin) doesn't
    const probeHeaders0 = new Headers(
      (fetchMock.mock.calls[0]![1] as RequestInit).headers as HeadersInit
    )
    const probeHeaders1 = new Headers(
      (fetchMock.mock.calls[1]![1] as RequestInit).headers as HeadersInit
    )
    const signinHeaders = new Headers(
      (fetchMock.mock.calls[2]![1] as RequestInit).headers as HeadersInit
    )
    expect(probeHeaders0.get("X-Lookup-Only")).toBe("1")
    expect(probeHeaders1.get("X-Lookup-Only")).toBe("1")
    expect(signinHeaders.get("X-Lookup-Only")).toBeNull()
  })

  it("multi-region: account on current region → no switch, signin there", async () => {
    const switchCalls: string[] = []
    fetchMock
      // probe global → hit (current is global)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, anonymous: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      // probe russia → 404
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "account_not_found" } }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(meResponse())
    const auth = makeAdapterMultiRegion({
      regions: ["global", "russia"],
      current: "global",
      setActive: (id) => switchCalls.push(id),
    })
    const session = await auth.signInWithGoogle()
    expect(session?.userId).toBe("u-1")
    expect(switchCalls).toEqual([]) // no switch needed
  })

  it("multi-region: no region has account → no switch, signin on current creates new", async () => {
    const switchCalls: string[] = []
    fetchMock
      // both probes 404 — no account anywhere
      .mockResolvedValueOnce(
        new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } })
      )
      .mockResolvedValueOnce(
        new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } })
      )
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(meResponse())
    const auth = makeAdapterMultiRegion({
      regions: ["global", "russia"],
      current: "global",
      setActive: (id) => switchCalls.push(id),
    })
    const session = await auth.signInWithGoogle()
    expect(session?.userId).toBe("u-1")
    expect(switchCalls).toEqual([])
  })

  it("multi-region: probe timeouts swallowed, falls through to signin on current", async () => {
    const switchCalls: string[] = []
    fetchMock
      .mockRejectedValueOnce(new TypeError("offline")) // probe global crash
      .mockRejectedValueOnce(new TypeError("offline")) // probe russia crash
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(meResponse())
    const auth = makeAdapterMultiRegion({
      regions: ["global", "russia"],
      current: "global",
      setActive: (id) => switchCalls.push(id),
    })
    const session = await auth.signInWithGoogle()
    expect(session?.userId).toBe("u-1")
    expect(switchCalls).toEqual([]) // can't switch on uncertainty — stay on current
  })

  it("multi-region: account on BOTH regions → prefers current (no switch)", async () => {
    const switchCalls: string[] = []
    fetchMock
      // both probes 200 exists
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, anonymous: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, anonymous: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(meResponse())
    const auth = makeAdapterMultiRegion({
      regions: ["global", "russia"],
      current: "global",
      setActive: (id) => switchCalls.push(id),
    })
    const session = await auth.signInWithGoogle()
    expect(session?.userId).toBe("u-1")
    expect(switchCalls).toEqual([]) // duplicate-on-both → stick with current
  })
})
