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

vi.mock("@capgo/capacitor-social-login", () => ({
  SocialLogin: {
    initialize: vi.fn(),
    login: vi.fn(),
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

interface AdapterOpts {
  currentRegionId?: string
  onHomeRegionMismatch?: (server: string, local: string) => void
}

function makeAdapter(opts: AdapterOpts = {}) {
  return useCapacitorAuth({
    baseUrl: () => "https://current.example/auth",
    resolveAuthBaseUrl: (id: string) => `https://${id}.example/auth`,
    currentRegionId: () => opts.currentRegionId ?? "global",
    onHomeRegionMismatch: opts.onHomeRegionMismatch,
    googleWebClientId: "g-web",
    googleIOSClientId: "g-ios",
  })
}

// Stable baseline /me body — tests override homeRegion case-by-case.
function meBody(homeRegion: string | undefined): Record<string, unknown> {
  const body: Record<string, unknown> = {
    userId: "user-1",
    email: null,
    name: null,
    pictureUrl: null,
    anonymous: true,
    tier: "free",
    tierExpiresAt: null,
  }
  if (homeRegion !== undefined) body.homeRegion = homeRegion
  return body
}

function stubInitializeRoundTrip(
  fetchMock: ReturnType<typeof vi.fn>,
  serverHomeRegion: string | undefined
): void {
  // POST /anon for the bootstrap, then GET /me — initialize() is the
  // simplest path that hits commitTokenResponse end-to-end.
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        accessToken: makeAccessJwt({ exp: futureExp, tier: "free", quota_id: "q1" }),
        refreshToken: "r1",
        userId: "user-1",
        anonymous: true,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  )
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(meBody(serverHomeRegion)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  )
}

describe("useCapacitorAuth home region reconcile", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    memPrefs.clear()
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("server's homeRegion differs from local → onHomeRegionMismatch fires with both", async () => {
    const onMismatch = vi.fn()
    stubInitializeRoundTrip(fetchMock, "russia")
    const auth = makeAdapter({ currentRegionId: "global", onHomeRegionMismatch: onMismatch })
    const session = await auth.initialize()
    expect(onMismatch).toHaveBeenCalledExactlyOnceWith("russia", "global")
    // The session also carries the server-truth region so consumers
    // (useAuthStore.homeRegion) see it without waiting for the next /me.
    expect(session.homeRegion).toBe("russia")
  })

  it("regions match → callback not fired", async () => {
    const onMismatch = vi.fn()
    stubInitializeRoundTrip(fetchMock, "global")
    const auth = makeAdapter({ currentRegionId: "global", onHomeRegionMismatch: onMismatch })
    const session = await auth.initialize()
    expect(onMismatch).not.toHaveBeenCalled()
    expect(session.homeRegion).toBe("global")
  })

  it("older server omits homeRegion → callback not fired, session.homeRegion is ''", async () => {
    const onMismatch = vi.fn()
    stubInitializeRoundTrip(fetchMock, undefined)
    const auth = makeAdapter({ currentRegionId: "global", onHomeRegionMismatch: onMismatch })
    const session = await auth.initialize()
    expect(onMismatch).not.toHaveBeenCalled()
    expect(session.homeRegion).toBe("")
  })
})
