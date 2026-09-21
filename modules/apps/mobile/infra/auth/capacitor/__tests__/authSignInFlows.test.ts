import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LoginResult } from "@capgo/capacitor-social-login"
import type { AuthSession } from "@ports/app/auth.js"
import type { TokenResponseBody } from "../authTokens.js"

const login = vi.fn<() => Promise<LoginResult>>()

vi.mock("@capgo/capacitor-social-login", () => ({
  SocialLogin: { initialize: async () => {}, login: () => login() },
}))

const { createSignInFlows } = await import("../authSignInFlows.js")

interface SentRequest {
  path: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const SESSION: AuthSession = {
  userId: "u1",
  email: "user@example.com",
  name: "Ada",
  picture: null,
  anonymous: false,
  accessTokenExpiresAt: 1,
  tier: "free",
  tierExpiresAt: null,
  quotaId: "q1",
}

const TOKENS: TokenResponseBody = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  userId: "u1",
  anonymous: false,
}

/** The sign-in flows plus what they sent and committed. */
function makeFlows(signinStatus = 200): {
  flows: ReturnType<typeof createSignInFlows>
  sent: SentRequest[]
  committed: TokenResponseBody[]
  events: string[]
} {
  const sent: SentRequest[] = []
  const committed: TokenResponseBody[] = []
  const events: string[] = []
  const flows = createSignInFlows({
    request: async (path, init) => {
      events.push(`request ${path}`)
      sent.push({
        path,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      })
      return new Response(JSON.stringify(TOKENS), { status: signinStatus })
    },
    getLocale: () => "en",
    ensureSocialInit: async () => {
      events.push("init")
    },
    authHeader: async () => ({ Authorization: "Bearer anon-token" }),
    readDeviceId: async () => "device-1",
    commit: async (body) => {
      committed.push(body)
      return SESSION
    },
  })
  return { flows, sent, committed, events }
}

function googleToken(idToken: string): LoginResult {
  return {
    provider: "google",
    result: {
      accessToken: null,
      idToken,
      profile: {
        email: "user@example.com",
        familyName: null,
        givenName: null,
        id: "g1",
        name: null,
        imageUrl: null,
      },
      responseType: "online",
    },
  }
}

function appleToken(idToken: string, givenName: string | null = null): LoginResult {
  return {
    provider: "apple",
    result: {
      accessToken: null,
      idToken,
      profile: { user: "a1", email: null, givenName, familyName: null },
    },
  }
}

describe("signInWithGoogle", () => {
  beforeEach(() => {
    login.mockReset()
  })

  it("exchanges the provider token for a session, upgrading the device's user", async () => {
    login.mockResolvedValue(googleToken("google-id-token"))
    const { flows, sent, committed } = makeFlows()

    await expect(flows.signInWithGoogle()).resolves.toEqual(SESSION)

    expect(sent).toHaveLength(1)
    expect(sent[0]!.path).toBe("/signin/google")
    expect(sent[0]!.body).toEqual({ idToken: "google-id-token" })
    expect(sent[0]!.headers.Authorization).toBe("Bearer anon-token")
    expect(committed).toEqual([TOKENS])
  })

  it("initializes the provider before asking it for a token", async () => {
    login.mockResolvedValue(googleToken("google-id-token"))
    const { flows, events } = makeFlows()

    await flows.signInWithGoogle()

    expect(events).toEqual(["init", "request /signin/google"])
  })

  it("leaves the session untouched when the user backs out", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    login.mockRejectedValue(new Error("canceled"))
    const { flows, sent, committed } = makeFlows()

    await expect(flows.signInWithGoogle()).resolves.toBeNull()

    expect(sent).toEqual([])
    expect(committed).toEqual([])
    vi.restoreAllMocks()
  })

  it("commits nothing when the backend rejects the provider token", async () => {
    login.mockResolvedValue(googleToken("stale-token"))
    const { flows, committed } = makeFlows(401)

    await expect(flows.signInWithGoogle()).rejects.toThrow("auth/signin/google: HTTP 401")

    expect(committed).toEqual([])
  })
})

describe("signInWithApple", () => {
  beforeEach(() => {
    login.mockReset()
  })

  it("sends the name Apple disclosed along with the token", async () => {
    login.mockResolvedValue(appleToken("apple-id-token", "Ada"))
    const { flows, sent, committed } = makeFlows()

    await expect(flows.signInWithApple()).resolves.toEqual(SESSION)

    expect(sent[0]!.path).toBe("/signin/apple")
    expect(sent[0]!.body).toEqual({ idToken: "apple-id-token", fullName: "Ada" })
    expect(committed).toEqual([TOKENS])
  })

  it("sends no name on a repeat authorization, where Apple discloses none", async () => {
    login.mockResolvedValue(appleToken("apple-id-token"))
    const { flows, sent } = makeFlows()

    await flows.signInWithApple()

    expect(sent[0]!.body).toEqual({ idToken: "apple-id-token" })
  })

  it("leaves the session untouched when the user dismisses the Apple sheet", async () => {
    login.mockRejectedValue({ errorMessage: "com.apple.AuthenticationServices error 1001." })
    const { flows, sent, committed } = makeFlows()

    await expect(flows.signInWithApple()).resolves.toBeNull()

    expect(sent).toEqual([])
    expect(committed).toEqual([])
  })

  it("commits nothing when the backend rejects the Apple token", async () => {
    login.mockResolvedValue(appleToken("stale-token"))
    const { flows, committed } = makeFlows(401)

    await expect(flows.signInWithApple()).rejects.toThrow("auth/signin/apple: HTTP 401")

    expect(committed).toEqual([])
  })

  it("surfaces a provider failure that is not a cancellation", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    login.mockRejectedValue({ errorMessage: "AuthorizationError error 1004." })
    const { flows, sent } = makeFlows()

    await expect(flows.signInWithApple()).rejects.toEqual({
      errorMessage: "AuthorizationError error 1004.",
    })

    expect(sent).toEqual([])
    vi.restoreAllMocks()
  })
})
