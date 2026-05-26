/**
 * Port for the lectorium auth service.
 *
 * On first launch the adapter bootstraps an anonymous session keyed to the
 * device's stable id (Capacitor `Device.getId()`). The user is reachable
 * via `userId` from that moment on — chat and any per-user feature can
 * already attach data to them.
 *
 * Later, when the user signs in with Google or Apple from Settings, the
 * adapter passes the current anonymous access token in the upgrade flow:
 * the server attaches the new (google|apple, sub) identity to the same
 * `userId`, so usage counters / saved state / chat history carry over.
 */

export type AuthStatus =
  | "uninitialized"
  | "restoring"
  | "anonymous"
  | "signedIn"
  | "signingIn"
  | "error"

export interface AuthSession {
  userId: string
  /** Display email — computed server-side from the user's verified identities. */
  email: string | null
  /** User-display name (Apple's fullName captured on first signin). */
  name: string | null
  /**
   * Profile picture URL captured at sign-in (Google only — Apple doesn't
   * expose one). Stored client-side; if the URL ever 404s the UI falls
   * back to initials.
   */
  picture: string | null
  anonymous: boolean
  accessTokenExpiresAt: number
  /** Subscription tier mirrored from RevenueCat ("free" | "pro"). Defaults
   * to "free" on stale tokens that pre-date this field. */
  tier: string
  /**
   * UNIX-epoch (ms) at which the Pro entitlement expires. `null` means
   * lifetime Pro (or free, where the concept doesn't apply) — never
   * coerce by date. The store coerces a "pro" tier whose expiry slid
   * into the past back to "free" via the public `tier` getter, so a
   * dropped EXPIRATION webhook can't keep stale Pro past the real
   * boundary.
   */
  tierExpiresAt: number | null
  /**
   * Server-side quota bucket identifier (mirror of JWT `quota_id` claim).
   * Stable across token rotations within the same identity — anonymous
   * device-bootstrap, Google, and Apple users each get a distinct
   * non-empty value (post PR-1, anon users no longer collapse to "").
   * Used by the chat store to scope persisted rate-limit lockout state
   * to the bucket the server's limiter actually keys on.
   */
  quotaId: string
}

/**
 * Outcome of a cross-region account migration. The caller surfaces this
 * to the UI via toast/dialog copy keyed on `code`; success carries the
 * fresh `userId` minted by the destination region.
 */
export type MigrationResult =
  | { ok: true; newUserId: string }
  | { ok: false; code: "unreachable" | "rejected" | "network" | "no_session"; message: string }

/**
 * Thrown by `signInWithGoogle` / `signInWithApple` when the X-Lookup-Only
 * probe of the current region returns 404. Carries the verified
 * idToken (and Apple's fullName, if surfaced once) so the caller can
 * present the retry-other-region dialog WITHOUT re-triggering the
 * SocialLogin popup: passing the idToken back to `lookupAccount` or
 * `completeSigninAfterRetry` resumes the flow with the same OAuth
 * material.
 */
export class SigninAccountNotFoundError extends Error {
  constructor(
    public readonly provider: "google" | "apple",
    public readonly idToken: string,
    public readonly fullName?: string
  ) {
    super(`signin/${provider}: account_not_found on current region`)
    this.name = "SigninAccountNotFoundError"
  }
}

export interface AuthPort {
  /**
   * Restore tokens from storage; if none, bootstrap an anonymous session.
   * Safe to call multiple times — idempotent on the server side.
   */
  initialize(): Promise<AuthSession>

  /**
   * OAuth signin via Google. Probes the current region first with
   * `X-Lookup-Only: 1`; on a 404 throws `SigninAccountNotFoundError`
   * carrying the verified idToken so the caller can drive the
   * retry-other-region UX (PR-3) without re-running the SocialLogin
   * popup. On hit, proceeds with the normal bootstrap and returns the
   * session. `null` on user-cancel.
   */
  signInWithGoogle(): Promise<AuthSession | null>
  /** Same probe-then-bootstrap flow as `signInWithGoogle`, for Apple. */
  signInWithApple(): Promise<AuthSession | null>

  /**
   * Bootstrap a new account on the CURRENT region using an OAuth idToken
   * we've already verified once (no X-Lookup-Only probe). Called by the
   * retry-other-region "Create new account here" branch after the user
   * decided to proceed despite the previous 404. Reuses the idToken
   * captured in `SigninAccountNotFoundError` so the user doesn't re-tap
   * the SocialLogin popup.
   */
  completeSigninAfterRetry(
    provider: "google" | "apple",
    idToken: string,
    fullName?: string
  ): Promise<AuthSession>

  signOut(): Promise<void>
  deleteAccount(): Promise<void>

  /**
   * Move the user's account to a different region. Mints a fresh access
   * token in the source region, presents it to `${dest}/auth/migrate-in`,
   * persists the destination's tokens locally, flips the composition
   * root's `activeServer` and schedules a fire-and-forget revoke on the
   * source. Anonymous sessions are rejected by the server (400) — the
   * caller should run a signOut + reboot in the new region instead.
   */
  migrateToRegion(newRegionId: string): Promise<MigrationResult>

  /**
   * Probe whether an account for the given OAuth identity lives on a
   * SPECIFIC region — different from the currently-active one. Used by
   * the retry-other-region signin UX (PR-3): when signin on the current
   * region returns 404 and the user picks "Create new account here", we
   * synchronously probe the OTHER region first to catch the "you already
   * have an account on Russia" case before bootstrapping a duplicate.
   *
   * Uses the same `X-Lookup-Only: 1` shortcut as
   * `lookupSigninCurrentRegion`, so the destination region verifies the
   * OAuth id-token (proves the caller holds the subject) and looks up
   * the identity without bootstrapping. The mobile client never has to
   * decode the OAuth subject locally.
   *
   * Returns `{exists, anonymous}` on a clean response. On any uncertainty
   * — timeout (3s), network error, non-2xx other than 404 — returns
   * `null` so the caller can surface the "we couldn't verify, dup-account
   * risk" warning instead of silently proceeding.
   */
  lookupAccount(
    regionId: string,
    provider: "google" | "apple",
    idToken: string
  ): Promise<{ exists: boolean; anonymous: boolean } | null>

  /** Latest cached session. `null` if `initialize` hasn't run yet. */
  getSession(): AuthSession | null

  /**
   * Return a fresh access token. Triggers `/auth/refresh` under a mutex if
   * the cached one is within 60s of expiry. Returns `null` if the session
   * is unrecoverable (e.g. refresh rejected) — caller should fall back to
   * `initialize()` to get a fresh anonymous session.
   */
  getAccessToken(): Promise<string | null>

  /**
   * Unconditionally call `/auth/refresh` and update the cached session.
   * Used after a RevenueCat purchase/restore so the new `tier` claim
   * lands in the access JWT immediately instead of waiting up to 15 min
   * for natural rotation.
   */
  refreshTokens(): Promise<AuthSession | null>

  /**
   * Server-side view of the current user. Read-only — does not rotate
   * tokens. Used by foreground-resume to detect a webhook-driven tier
   * flip without paying the cost of a refresh round-trip every time
   * the app comes to the foreground.
   */
  fetchMe(): Promise<MeView | null>

  /** Subscribe to session changes (login/logout/refresh). Returns unsub. */
  onSessionChange(listener: (s: AuthSession | null) => void): () => void
}

/** Subset of /auth/me the foreground-resume sync cares about. */
export interface MeView {
  tier: string
  tierExpiresAt: number | null
}

export interface AuthConfig {
  /**
   * Lazy getter for the base URL of the auth service (e.g.
   * `() => "https://api.example/auth"`). Resolved at every fetch call
   * so a region flip via `lectorium.activeServer` routes subsequent
   * auth traffic to the new backend without re-initializing the adapter.
   */
  baseUrl: () => string
  /**
   * Resolve the auth base URL of *another* region. Used by
   * `migrateToRegion` to reach the destination's `/auth/migrate-in`
   * endpoint without coupling the adapter to the in-domain SERVERS
   * registry. Must throw on an unknown region id — the adapter maps
   * the throw to `MigrationResult.code = "rejected"`.
   */
  resolveAuthBaseUrl: (regionId: string) => string
  /** Id of the region the adapter is currently signed into. Captured at
   *  the moment of migration so the source-side revoke (queued in
   *  Preferences) knows where to POST when it later drains. */
  currentRegionId: () => string
  /**
   * Hook the composition root uses to react to a successful migration:
   * flip `activeServer` to `newRegionId`, enqueue a `migrate-revoke`
   * on `sourceRegionId` carrying the still-valid source bearer, and
   * trigger any other region-bound bookkeeping. Optional only to keep
   * tests / web stubs ergonomic — production wiring always sets it.
   */
  onMigrationCompleted?: (newRegionId: string, sourceRegionId: string, sourceBearer: string) => void
  /** Google OAuth web client ID (used by capgo on Android & Web). */
  googleWebClientId: string
  /** Google OAuth iOS client ID. */
  googleIOSClientId: string
}
