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
import { SigninAccountNotFoundError } from "@ports/app/auth.js"

function b64url(input: string): string {
  return btoa(input).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}
function makeAccessJwt(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
    JSON.stringify(claims)
  )}.signature`
}

const futureExp = Math.floor(Date.now() / 1000) + 3600

function makeAdapter() {
  return useCapacitorAuth({
    baseUrl: () => "https://current.example/auth",
    resolveAuthBaseUrl: (id: string) => `https://${id}.example/auth`,
    currentRegionId: () => "global",
    googleWebClientId: "g-web",
    googleIOSClientId: "g-ios",
  })
}

describe("useCapacitorAuth signin probe-then-bootstrap", () => {
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

  it("X-Lookup-Only 404 → throws SigninAccountNotFoundError, no bootstrap call", async () => {
    // First fetch is the probe — return 404. The signin call MUST NOT
    // happen; if the adapter erroneously falls through, the second
    // mockResolvedValueOnce is missing and fetch returns undefined,
    // tripping the assertion below.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "account_not_found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    )
    const auth = makeAdapter()
    await expect(auth.signInWithGoogle()).rejects.toBeInstanceOf(SigninAccountNotFoundError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe("https://current.example/auth/signin/google")
    const headers = new Headers((init as RequestInit).headers as HeadersInit)
    expect(headers.get("X-Lookup-Only")).toBe("1")
  })

  it("X-Lookup-Only 200 (hit) → falls through to bootstrap, returns session", async () => {
    const accessTok = makeAccessJwt({ exp: futureExp, tier: "free", quota_id: "q1" })
    // 1: probe responds 200 (account exists). 2: real signin commits.
    // 3: fetchMeBody call after commit.
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ exists: true, anonymous: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: accessTok,
            refreshToken: "r-1",
            userId: "u-1",
            anonymous: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            userId: "u-1",
            email: null,
            name: null,
            pictureUrl: null,
            anonymous: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    const auth = makeAdapter()
    const session = await auth.signInWithGoogle()
    expect(session?.userId).toBe("u-1")
    // Second fetch is the real signin — no X-Lookup-Only header.
    const [, signinInit] = fetchMock.mock.calls[1]!
    const signinHeaders = new Headers((signinInit as RequestInit).headers as HeadersInit)
    expect(signinHeaders.get("X-Lookup-Only")).toBeNull()
  })

  it("probe network error → swallow, fall through to bootstrap (errors surface there)", async () => {
    const accessTok = makeAccessJwt({ exp: futureExp, tier: "free", quota_id: "q1" })
    fetchMock
      .mockRejectedValueOnce(new TypeError("offline")) // probe explodes
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: accessTok,
            refreshToken: "r-1",
            userId: "u-1",
            anonymous: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            userId: "u-1",
            email: null,
            name: null,
            pictureUrl: null,
            anonymous: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    const auth = makeAdapter()
    const session = await auth.signInWithGoogle()
    expect(session?.userId).toBe("u-1")
  })

  it("completeSigninAfterRetry — bootstraps with idToken without probing", async () => {
    const accessTok = makeAccessJwt({ exp: futureExp, tier: "free", quota_id: "q1" })
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            accessToken: accessTok,
            refreshToken: "r-1",
            userId: "u-1",
            anonymous: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            userId: "u-1",
            email: null,
            name: null,
            pictureUrl: null,
            anonymous: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    const auth = makeAdapter()
    const session = await auth.completeSigninAfterRetry("google", "id-token-x")
    expect(session.userId).toBe("u-1")
    // First call must be the real signin (no probe).
    const [, init] = fetchMock.mock.calls[0]!
    const headers = new Headers((init as RequestInit).headers as HeadersInit)
    expect(headers.get("X-Lookup-Only")).toBeNull()
  })

  it("SigninAccountNotFoundError carries provider + idToken", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "account_not_found" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })
    )
    const auth = makeAdapter()
    try {
      await auth.signInWithGoogle()
      throw new Error("expected throw")
    } catch (e) {
      expect(e).toBeInstanceOf(SigninAccountNotFoundError)
      const err = e as SigninAccountNotFoundError
      expect(err.provider).toBe("google")
      expect(err.idToken).toBe("stub-id-token")
    }
  })
})
