import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AuthConfig, AuthSession } from "@ports/app/auth.js"

const prefs = new Map<string, string>()

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }))
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

import { SocialLogin } from "@capgo/capacitor-social-login"

import { useCapacitorAuth } from "../useCapacitorAuth.js"

const jwt = (claims: Record<string, unknown> = {}): string =>
  `h.${btoa(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600,
      tier: "free",
      quota_id: "q1",
      sub: "user-1",
      ...claims,
    })
  )}.s`

const ACCESS = jwt()

const storedSession = {
  accessToken: ACCESS,
  refreshToken: "refresh-1",
  userId: "user-1",
  email: "reader@example.com",
  name: "Reader",
  picture: null,
  anonymous: false,
  accessTokenExpiresAt: Date.now() + 3_600_000,
  tier: "free",
  tierExpiresAt: null,
  quotaId: "q1",
}

interface Call {
  path: string
  init?: RequestInit
}

interface Harness {
  readonly auth: ReturnType<typeof useCapacitorAuth>
  readonly calls: Call[]
}

/** A restored signed-in session whose `/me` and `/signout` answer as scripted. */
function makeHarness(
  routes: Record<string, () => Promise<Response> | Response> = {},
  options: { session?: boolean } = {}
): Harness {
  if (options.session !== false) prefs.set("auth.tokens", JSON.stringify(storedSession))
  const calls: Call[] = []
  const request: AuthConfig["request"] = async (path, init) => {
    calls.push({ path, init })
    const route = routes[path]
    if (!route) return new Response(null, { status: 404 })
    return route()
  }
  const cfg: AuthConfig = {
    request,
    googleWebClientId: "web-client",
    googleIOSClientId: "ios-client",
  }
  return { auth: useCapacitorAuth(cfg), calls }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

const pathsOf = (h: Harness): string[] => h.calls.map((c) => c.path)

describe("useCapacitorAuth — signOut", () => {
  beforeEach(() => {
    prefs.clear()
    vi.mocked(SocialLogin.logout).mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => vi.restoreAllMocks())

  it("drops the session and the persisted tokens", async () => {
    const h = makeHarness({ "/signout": () => new Response(null, { status: 204 }) })
    await h.auth.initialize()

    await h.auth.signOut()

    expect(h.auth.getSession()).toBeNull()
    expect(prefs.get("auth.tokens")).toBeUndefined()
  })

  it("tells the server which refresh token to revoke", async () => {
    const h = makeHarness({ "/signout": () => new Response(null, { status: 204 }) })
    await h.auth.initialize()

    await h.auth.signOut()

    const call = h.calls.find((c) => c.path === "/signout")
    expect(JSON.parse(String(call?.init?.body))).toEqual({ refreshToken: "refresh-1" })
  })

  it("signs the user out locally even when the server call fails", async () => {
    const h = makeHarness({
      "/signout": () => {
        throw new TypeError("Failed to fetch")
      },
    })
    await h.auth.initialize()

    await expect(h.auth.signOut()).resolves.toBeUndefined()

    // Leaving the tokens behind would show a signed-in app the user just left.
    expect(h.auth.getSession()).toBeNull()
    expect(prefs.get("auth.tokens")).toBeUndefined()
  })

  it("signs the user out locally even when the social provider logout throws", async () => {
    vi.mocked(SocialLogin.logout).mockRejectedValue(new Error("no provider configured"))
    const h = makeHarness({ "/signout": () => new Response(null, { status: 204 }) })
    await h.auth.initialize()

    await expect(h.auth.signOut()).resolves.toBeUndefined()

    expect(h.auth.getSession()).toBeNull()
  })

  it("does nothing when there is no session to sign out of", async () => {
    const h = makeHarness({}, { session: false })

    await h.auth.signOut()

    expect(pathsOf(h)).toEqual([])
  })

  it("notifies subscribers that the session is gone", async () => {
    const h = makeHarness({ "/signout": () => new Response(null, { status: 204 }) })
    await h.auth.initialize()
    const seen: Array<AuthSession | null> = []
    const unsubscribe = h.auth.onSessionChange((s) => seen.push(s))

    await h.auth.signOut()

    expect(seen).toEqual([null])
    unsubscribe()
  })

  it("stops notifying an unsubscribed listener", async () => {
    const h = makeHarness({ "/signout": () => new Response(null, { status: 204 }) })
    await h.auth.initialize()
    const seen: Array<AuthSession | null> = []
    h.auth.onSessionChange((s) => seen.push(s))()

    await h.auth.signOut()

    expect(seen).toEqual([])
  })
})

describe("useCapacitorAuth — fetchMe", () => {
  beforeEach(() => prefs.clear())
  afterEach(() => vi.restoreAllMocks())

  it("reports the tier the server holds, with the expiry as epoch ms", async () => {
    const h = makeHarness({
      "/me": () =>
        json(200, {
          userId: "user-1",
          tier: "pro",
          tierExpiresAt: "2030-01-01T00:00:00.000Z",
        }),
    })
    await h.auth.initialize()

    expect(await h.auth.fetchMe()).toEqual({
      tier: "pro",
      tierExpiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
    })
  })

  it("reads a tier-less body as free, with no expiry", async () => {
    const h = makeHarness({ "/me": () => json(200, { userId: "user-1" }) })
    await h.auth.initialize()

    expect(await h.auth.fetchMe()).toEqual({ tier: "free", tierExpiresAt: null })
  })

  it("answers null when /me fails rather than downgrading the user to free", async () => {
    const h = makeHarness({ "/me": () => new Response(null, { status: 502 }) })
    await h.auth.initialize()

    // A 502 read as "free" would revoke Pro from a paying reader on a blip.
    expect(await h.auth.fetchMe()).toBeNull()
  })

  it("answers null without asking /me when no token can be obtained", async () => {
    const h = makeHarness({ "/anonymous": () => new Response(null, { status: 400 }) })
    prefs.clear()

    expect(await h.auth.fetchMe()).toBeNull()
    expect(pathsOf(h)).not.toContain("/me")
  })
})
