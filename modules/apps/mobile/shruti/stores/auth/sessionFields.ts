import type { AuthSession, AuthStatus } from "@ports/app/auth.js"

/** The store's session refs, as a plain snapshot. */
export interface SessionFields {
  readonly userId: string | null
  readonly email: string | null
  readonly name: string | null
  readonly picture: string | null
  readonly anonymous: boolean
  readonly rawTier: string
  readonly tierExpiresAt: number | null
  readonly quotaId: string
  readonly status: AuthStatus
}

/** Flatten a port session into the values the store mirrors; `null` is the signed-out shape. */
export function readSessionFields(s: AuthSession | null): SessionFields {
  if (!s) {
    return {
      userId: null,
      email: null,
      name: null,
      picture: null,
      anonymous: true,
      rawTier: "free",
      tierExpiresAt: null,
      quotaId: "",
      status: "uninitialized",
    }
  }
  return {
    userId: s.userId,
    email: s.email,
    name: s.name,
    picture: s.picture,
    anonymous: s.anonymous,
    rawTier: s.tier || "free",
    tierExpiresAt: s.tierExpiresAt ?? null,
    quotaId: s.quotaId ?? "",
    status: s.anonymous ? "anonymous" : "signedIn",
  }
}
