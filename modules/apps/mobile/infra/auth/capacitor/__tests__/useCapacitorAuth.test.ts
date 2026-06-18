import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthConfig } from "@ports/app/auth.js"

// In-memory Preferences so loadTokens/persistTokens behave like the device.
const prefs = new Map<string, string>()

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android" },
}))
vi.mock("@capacitor/device", () => ({
  Device: { getId: async () => ({ identifier: "device-1" }) },
}))
vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value)
    },
    remove: async ({ key }: { key: string }) => {
      prefs.delete(key)
    },
  },
}))
vi.mock("@capgo/capacitor-social-login", () => ({
  SocialLogin: { initialize: vi.fn(), login: vi.fn(), logout: vi.fn() },
}))

import { useCapacitorAuth } from "../useCapacitorAuth.js"

// Access token expiring an hour out so getAccessToken() doesn't try to refresh.
const jwt = (claims: Record<string, unknown>): string =>
  `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, tier: "free", quota_id: "q1", ...claims }))}.s`

const resp = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

const anonBody = {
  accessToken: jwt({ anonymous: true }),
  refreshToken: "refresh-1",
  userId: "user-1",
  anonymous: true,
}
const meBody = {
  userId: "user-1",
  email: null,
  name: null,
  pictureUrl: null,
  anonymous: true,
  tier: "free",
  tierExpiresAt: null,
}

/** Build an AuthConfig whose /anonymous responses come from `anonSeq` (one
 *  per call, last entry reused), and whose /me always succeeds. */
function makeCfg(anonSeq: Array<ReturnType<typeof resp>>): {
  cfg: AuthConfig
  request: ReturnType<typeof vi.fn>
} {
  let i = 0
  const request = vi.fn(async (path: string) => {
    if (path === "/anonymous") return anonSeq[Math.min(i++, anonSeq.length - 1)]
    if (path === "/me") return resp(200, meBody)
    throw new Error(`unexpected request ${path}`)
  })
  return {
    request: request as ReturnType<typeof vi.fn>,
    cfg: { request, googleWebClientId: "x", googleIOSClientId: "y" } as unknown as AuthConfig,
  }
}

const anonCalls = (request: ReturnType<typeof vi.fn>): number =>
  request.mock.calls.filter((c) => c[0] === "/anonymous").length

describe("useCapacitorAuth — anonymous bootstrap resilience", () => {
  beforeEach(() => prefs.clear())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("retries a transient 429 on /anonymous and then succeeds", async () => {
    vi.useFakeTimers()
    const { cfg, request } = makeCfg([resp(429, {}), resp(429, {}), resp(200, anonBody)])
    const auth = useCapacitorAuth(cfg)

    const p = auth.initialize()
    await vi.runAllTimersAsync()
    const session = await p

    expect(session.userId).toBe("user-1")
    expect(session.anonymous).toBe(true)
    expect(anonCalls(request)).toBe(3)
  })

  it("gives up after exhausting retries on a persistent 429", async () => {
    vi.useFakeTimers()
    const { cfg, request } = makeCfg([resp(429, {})])
    const auth = useCapacitorAuth(cfg)

    const p = auth.initialize().catch((e) => e)
    await vi.runAllTimersAsync()
    const result = await p

    expect(result).toBeInstanceOf(Error)
    // initial attempt + 3 backoff retries
    expect(anonCalls(request)).toBe(4)
  })

  it("does NOT retry a non-transient 4xx (e.g. 400)", async () => {
    const { cfg, request } = makeCfg([resp(400, {})])
    const auth = useCapacitorAuth(cfg)

    await expect(auth.initialize()).rejects.toThrow(/HTTP 400/)
    expect(anonCalls(request)).toBe(1)
  })

  it("getAccessToken re-mints the anonymous session when there is none", async () => {
    const { cfg, request } = makeCfg([resp(200, anonBody)])
    const auth = useCapacitorAuth(cfg)

    // No initialize(), no stored tokens — the chat token provider asking
    // for a token must recover instead of returning null forever.
    const token = await auth.getAccessToken()

    expect(token).toBe(anonBody.accessToken)
    expect(anonCalls(request)).toBe(1)
    expect(auth.getSession()?.anonymous).toBe(true)
  })

  it("coalesces concurrent bootstraps behind a single /anonymous call", async () => {
    const { cfg, request } = makeCfg([resp(200, anonBody)])
    const auth = useCapacitorAuth(cfg)

    const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()])

    expect(a).toBe(anonBody.accessToken)
    expect(b).toBe(anonBody.accessToken)
    expect(anonCalls(request)).toBe(1)
  })
})
