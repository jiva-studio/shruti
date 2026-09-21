import { describe, expect, it } from "vitest"
import {
  decodeAccessClaims,
  mergeStoredTokens,
  sessionFromTokens,
  type AccessClaims,
  type MeBody,
  type StoredTokens,
  type TokenResponseBody,
} from "../authTokens.js"

function jwt(payload: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_")
  return `header.${b64}.signature`
}

const FREE_CLAIMS: AccessClaims = { expMs: 0, tier: "free", tierExpiresAtMs: null, quotaId: "" }

const body: TokenResponseBody = {
  accessToken: "access",
  refreshToken: "refresh",
  userId: "u1",
  anonymous: false,
}

function storedTokens(over: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    userId: "u1",
    email: "prior@example.com",
    name: "Prior Name",
    picture: "prior.png",
    anonymous: false,
    accessTokenExpiresAt: 1,
    tier: "free",
    tierExpiresAt: null,
    quotaId: "q",
    ...over,
  }
}

function meBody(over: Partial<MeBody> = {}): MeBody {
  return {
    userId: "u1",
    email: "me@example.com",
    name: "Me",
    pictureUrl: "me.png",
    anonymous: false,
    ...over,
  }
}

describe("decodeAccessClaims", () => {
  it("reads expiry, tier and quota bucket off the token", () => {
    const claims = decodeAccessClaims(jwt({ exp: 1700, tier: "pro", quota_id: "bucket-1" }))
    expect(claims).toEqual({
      expMs: 1_700_000,
      tier: "pro",
      tierExpiresAtMs: null,
      quotaId: "bucket-1",
    })
  })

  it("converts a tier expiry from seconds to milliseconds", () => {
    expect(decodeAccessClaims(jwt({ tier_expires_at: 1700 })).tierExpiresAtMs).toBe(1_700_000)
  })

  it("reports no tier expiry at all for a zero claim, which means lifetime or free", () => {
    expect(decodeAccessClaims(jwt({ tier_expires_at: 0 })).tierExpiresAtMs).toBeNull()
  })

  it("falls back to the free defaults for a token it cannot decode", () => {
    expect(decodeAccessClaims("not-a-jwt")).toEqual(FREE_CLAIMS)
    expect(decodeAccessClaims("")).toEqual(FREE_CLAIMS)
  })

  it("ignores claims of the wrong type", () => {
    expect(decodeAccessClaims(jwt({ exp: "soon", tier: 7, quota_id: null }))).toEqual(FREE_CLAIMS)
  })
})

describe("mergeStoredTokens", () => {
  it("takes the identity from /me when it answered", () => {
    const merged = mergeStoredTokens(body, meBody(), FREE_CLAIMS, null)
    expect(merged.email).toBe("me@example.com")
    expect(merged.name).toBe("Me")
    expect(merged.picture).toBe("me.png")
  })

  it("keeps the stored identity when /me did not answer", () => {
    const merged = mergeStoredTokens(body, null, FREE_CLAIMS, storedTokens())
    expect(merged.email).toBe("prior@example.com")
    expect(merged.name).toBe("Prior Name")
    expect(merged.picture).toBe("prior.png")
  })

  it("keeps the stored field when /me has none, so a sparse profile erases nothing", () => {
    const merged = mergeStoredTokens(body, meBody({ name: null }), FREE_CLAIMS, storedTokens())
    expect(merged.name).toBe("Prior Name")
  })

  it("carries nothing forward without a prior", () => {
    const merged = mergeStoredTokens(body, null, FREE_CLAIMS, null)
    expect(merged.email).toBeNull()
    expect(merged.name).toBeNull()
    expect(merged.picture).toBeNull()
  })

  it("prefers the token's tier over /me's", () => {
    const claims: AccessClaims = { ...FREE_CLAIMS, tier: "pro" }
    expect(mergeStoredTokens(body, meBody({ tier: "free" }), claims, null).tier).toBe("pro")
  })

  it("falls back to /me's tier for a token that carries none", () => {
    const claims: AccessClaims = { ...FREE_CLAIMS, tier: "" }
    expect(mergeStoredTokens(body, meBody({ tier: "pro" }), claims, null).tier).toBe("pro")
  })

  it("prefers the token's tier expiry over /me's", () => {
    const claims: AccessClaims = { ...FREE_CLAIMS, tierExpiresAtMs: 1000 }
    const me = meBody({ tierExpiresAt: "2030-01-01T00:00:00Z" })
    expect(mergeStoredTokens(body, me, claims, null).tierExpiresAt).toBe(1000)
  })

  it("parses /me's tier expiry for a token that carries none", () => {
    const me = meBody({ tierExpiresAt: "2030-01-01T00:00:00Z" })
    expect(mergeStoredTokens(body, me, FREE_CLAIMS, null).tierExpiresAt).toBe(
      Date.parse("2030-01-01T00:00:00Z")
    )
  })

  it("reports no tier expiry when /me's is unparseable", () => {
    const me = meBody({ tierExpiresAt: "whenever" })
    expect(mergeStoredTokens(body, me, FREE_CLAIMS, null).tierExpiresAt).toBeNull()
  })

  it("takes the tokens and the expiry off the response and its claims", () => {
    const claims: AccessClaims = { ...FREE_CLAIMS, expMs: 42, quotaId: "q9" }
    const merged = mergeStoredTokens(body, null, claims, null)
    expect(merged.accessToken).toBe("access")
    expect(merged.refreshToken).toBe("refresh")
    expect(merged.userId).toBe("u1")
    expect(merged.accessTokenExpiresAt).toBe(42)
    expect(merged.quotaId).toBe("q9")
  })
})

describe("sessionFromTokens", () => {
  it("reports a blank tier as free", () => {
    expect(sessionFromTokens(storedTokens({ tier: "" })).tier).toBe("free")
  })

  it("passes the identity through", () => {
    const session = sessionFromTokens(storedTokens({ anonymous: true, accessTokenExpiresAt: 9 }))
    expect(session.userId).toBe("u1")
    expect(session.anonymous).toBe(true)
    expect(session.accessTokenExpiresAt).toBe(9)
  })
})
