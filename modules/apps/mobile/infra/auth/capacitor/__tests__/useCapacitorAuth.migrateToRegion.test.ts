import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// In-memory Preferences mock. Mirrors the @capacitor/preferences shape
// the adapter expects (get/set/remove with {key} / {key,value}).
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

// SocialLogin is only touched on signin paths — migrate-in doesn't
// reach it, but the import must resolve. Capacitor.getPlatform is read
// by the anonymous bootstrap path (not exercised here).
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

// Build a tokens payload whose access JWT has a future exp + minimal
// claims. b64url-encodes the parts; signature is irrelevant here —
// decodeAccessClaims only reads payload.
function b64url(input: string): string {
  return btoa(input).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}
function makeAccessJwt(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const payload = b64url(JSON.stringify(claims))
  return `${header}.${payload}.signature`
}

const futureExp = Math.floor(Date.now() / 1000) + 3600 // 1h ahead

function defaultClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exp: futureExp,
    tier: "free",
    quota_id: "qid-abc",
    ...over,
  }
}

describe("useCapacitorAuth.migrateToRegion", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let onMigrationCompleted: ReturnType<
    typeof vi.fn<(newRegionId: string, sourceRegionId: string, sourceBearer: string) => void>
  >

  beforeEach(() => {
    memPrefs.clear()
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    onMigrationCompleted =
      vi.fn<(newRegionId: string, sourceRegionId: string, sourceBearer: string) => void>()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeAdapter(overrides: { resolveAuthBaseUrl?: (id: string) => string } = {}) {
    return useCapacitorAuth({
      baseUrl: () => "https://source.example/auth",
      resolveAuthBaseUrl:
        overrides.resolveAuthBaseUrl ??
        ((regionId: string) => {
          if (regionId === "russia") return "https://russia.example/auth"
          if (regionId === "global") return "https://global.example/auth"
          throw new Error(`unknown region: ${regionId}`)
        }),
      currentRegionId: () => "global",
      onMigrationCompleted,
      googleWebClientId: "g-web",
      googleIOSClientId: "g-ios",
    })
  }

  it("no session → returns no_session, never hits fetch", async () => {
    const auth = makeAdapter()
    // Skip initialize → no stored tokens → getAccessToken returns null.
    const result = await auth.migrateToRegion("russia")
    expect(result).toEqual({ ok: false, code: "no_session", message: "no active session" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onMigrationCompleted).not.toHaveBeenCalled()
  })

  it("unknown region id → rejected, never hits fetch", async () => {
    // Seed a valid session first so we get past the no_session guard.
    memPrefs.set(
      "auth.tokens",
      JSON.stringify({
        accessToken: makeAccessJwt(defaultClaims()),
        refreshToken: "r",
        userId: "u-source",
        email: null,
        name: null,
        picture: null,
        anonymous: false,
        accessTokenExpiresAt: Date.now() + 3600_000,
        tier: "free",
        tierExpiresAt: null,
        quotaId: "qid-abc",
      })
    )
    const auth = makeAdapter()
    await auth.initialize()
    const result = await auth.migrateToRegion("atlantis")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("rejected")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("happy path: POSTs /migrate-in, persists destination tokens, fires onMigrationCompleted", async () => {
    memPrefs.set(
      "auth.tokens",
      JSON.stringify({
        accessToken: makeAccessJwt(defaultClaims()),
        refreshToken: "r-old",
        userId: "u-source",
        email: "x@y.z",
        name: "X",
        picture: null,
        anonymous: false,
        accessTokenExpiresAt: Date.now() + 3600_000,
        tier: "free",
        tierExpiresAt: null,
        quotaId: "qid-abc",
      })
    )
    const newAccess = makeAccessJwt(defaultClaims({ quota_id: "qid-dest" }))
    // Migrate-in response (token body), then /me lookup (fetchMeBody).
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: newAccess,
            refreshToken: "r-new",
            userId: "u-dest",
            anonymous: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            userId: "u-dest",
            email: null,
            name: null,
            pictureUrl: null,
            anonymous: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    const auth = makeAdapter()
    await auth.initialize()
    const result = await auth.migrateToRegion("russia")
    expect(result).toEqual({ ok: true, newUserId: "u-dest" })
    const migrateCall = fetchMock.mock.calls[0]!
    expect(migrateCall[0]).toBe("https://russia.example/auth/migrate-in")
    expect((migrateCall[1] as RequestInit).method).toBe("POST")
    // Destination tokens persisted (under same Preferences key); the
    // adapter's session getter exposes the new userId.
    expect(auth.getSession()?.userId).toBe("u-dest")
    expect(onMigrationCompleted).toHaveBeenCalledWith("russia", "global", expect.any(String))
  })

  it("status 400 from /migrate-in → rejected (anonymous-only identities)", async () => {
    memPrefs.set(
      "auth.tokens",
      JSON.stringify({
        accessToken: makeAccessJwt(defaultClaims()),
        refreshToken: "r",
        userId: "u-source",
        email: null,
        name: null,
        picture: null,
        anonymous: true,
        accessTokenExpiresAt: Date.now() + 3600_000,
        tier: "free",
        tierExpiresAt: null,
        quotaId: "qid-anon",
      })
    )
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }))
    const auth = makeAdapter()
    await auth.initialize()
    const result = await auth.migrateToRegion("russia")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("rejected")
    expect(onMigrationCompleted).not.toHaveBeenCalled()
  })

  it("status 5xx from /migrate-in → unreachable", async () => {
    memPrefs.set(
      "auth.tokens",
      JSON.stringify({
        accessToken: makeAccessJwt(defaultClaims()),
        refreshToken: "r",
        userId: "u-source",
        email: null,
        name: null,
        picture: null,
        anonymous: false,
        accessTokenExpiresAt: Date.now() + 3600_000,
        tier: "free",
        tierExpiresAt: null,
        quotaId: "qid",
      })
    )
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
    const auth = makeAdapter()
    await auth.initialize()
    const result = await auth.migrateToRegion("russia")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("unreachable")
  })

  it("network error → network code", async () => {
    memPrefs.set(
      "auth.tokens",
      JSON.stringify({
        accessToken: makeAccessJwt(defaultClaims()),
        refreshToken: "r",
        userId: "u-source",
        email: null,
        name: null,
        picture: null,
        anonymous: false,
        accessTokenExpiresAt: Date.now() + 3600_000,
        tier: "free",
        tierExpiresAt: null,
        quotaId: "qid",
      })
    )
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
    const auth = makeAdapter()
    await auth.initialize()
    const result = await auth.migrateToRegion("russia")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("network")
  })
})
