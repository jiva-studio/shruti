import type { AuthSession } from "@ports/app/auth.js"

export interface StoredTokens {
  accessToken: string
  refreshToken: string
  userId: string
  email: string | null
  name: string | null
  picture: string | null
  anonymous: boolean
  accessTokenExpiresAt: number
  tier: string
  // UNIX-epoch ms; null = lifetime Pro or free. See AuthSession docs.
  tierExpiresAt: number | null
  // JWT `quota_id` claim — server-side rate-limit bucket id. Empty string on
  // tokens minted before anonymous users had a stable device-subject hash.
  quotaId: string
}

export interface TokenResponseBody {
  accessToken: string
  refreshToken: string
  userId: string
  anonymous: boolean
}

export interface MeBody {
  userId: string
  email: string | null
  name: string | null
  pictureUrl: string | null
  anonymous: boolean
  tier?: string
  tierExpiresAt?: string | null
}

export interface AccessClaims {
  expMs: number
  tier: string
  tierExpiresAtMs: number | null
  quotaId: string
}

const NO_CLAIMS: AccessClaims = { expMs: 0, tier: "free", tierExpiresAtMs: null, quotaId: "" }

function decodeJwtPayload(accessToken: string): Record<string, unknown> {
  const [, payloadB64] = accessToken.split(".")
  return JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")))
}

/**
 * The claims the app reads out of an access token. A token the app cannot
 * decode yields the free-tier defaults rather than throwing — every caller of
 * this is on a path that must still produce a usable session.
 */
export function decodeAccessClaims(accessToken: string): AccessClaims {
  try {
    const json = decodeJwtPayload(accessToken)
    // `tier_expires_at` is UNIX seconds; 0 or missing means lifetime Pro or
    // free, exposed as null so nothing coerces those two by date.
    const rawExp = typeof json.tier_expires_at === "number" ? json.tier_expires_at : 0
    return {
      expMs: typeof json.exp === "number" ? json.exp * 1000 : 0,
      tier: typeof json.tier === "string" ? json.tier : "free",
      tierExpiresAtMs: rawExp > 0 ? rawExp * 1000 : null,
      quotaId: typeof json.quota_id === "string" ? json.quota_id : "",
    }
  } catch {
    return NO_CLAIMS
  }
}

export function sessionFromTokens(t: StoredTokens): AuthSession {
  return {
    userId: t.userId,
    email: t.email,
    name: t.name,
    picture: t.picture,
    anonymous: t.anonymous,
    accessTokenExpiresAt: t.accessTokenExpiresAt,
    tier: t.tier || "free",
    tierExpiresAt: t.tierExpiresAt ?? null,
    quotaId: t.quotaId ?? "",
  }
}

/** The JWT claim wins; `/me`'s ISO string is the tie-breaker for tokens
 *  minted before the claim existed. */
function resolveTierExpiry(claims: AccessClaims, me: MeBody | null): number | null {
  if (claims.tierExpiresAtMs !== null) return claims.tierExpiresAtMs
  if (!me?.tierExpiresAt) return null
  const parsed = Date.parse(me.tierExpiresAt)
  return Number.isFinite(parsed) ? parsed : null
}

function firstPresent(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== undefined) return value
  }
  return null
}

/**
 * The row to persist for a fresh token pair.
 *
 * `/me` is best-effort — a 502, an offline blip and a genuinely empty profile
 * all arrive as null — so a failed answer must not erase the display identity.
 * `prior` therefore carries forward, and the caller must pass it only when it
 * belongs to the same user: a sign-in that swaps accounts must not inherit the
 * previous account's email, name or avatar.
 */
export function mergeStoredTokens(
  body: TokenResponseBody,
  me: MeBody | null,
  claims: AccessClaims,
  prior: StoredTokens | null
): StoredTokens {
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.userId,
    email: firstPresent(me?.email, prior?.email),
    name: firstPresent(me?.name, prior?.name),
    picture: firstPresent(me?.pictureUrl, prior?.picture),
    anonymous: body.anonymous,
    accessTokenExpiresAt: claims.expMs,
    // The JWT is what the chat service actually sees, so its claim leads;
    // `/me`'s tier only stands in for a token that lacks it.
    tier: claims.tier || me?.tier || "free",
    tierExpiresAt: resolveTierExpiry(claims, me),
    quotaId: claims.quotaId,
  }
}
