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

export interface AuthPort {
  /**
   * Restore tokens from storage; if none, bootstrap an anonymous session.
   * Safe to call multiple times — idempotent on the server side.
   */
  initialize(): Promise<AuthSession>

  /** OAuth signin via Google. Returns `null` on user-cancel. */
  signInWithGoogle(): Promise<AuthSession | null>
  /** OAuth signin via Apple. Returns `null` on user-cancel. */
  signInWithApple(): Promise<AuthSession | null>

  /**
   * Request a one-time sign-in code be emailed. Passwordless — works for
   * both new and returning users (the server unifies signup + login).
   * Resolves on a sent code; throws `EmailOtpError` otherwise
   * (invalid-email / throttled / disabled / network).
   */
  requestEmailOtp(email: string): Promise<void>

  /**
   * Verify an emailed code and upgrade to a signed-in session. An
   * anonymous session in play is upgraded in place (same userId), exactly
   * like the social flows. Throws `EmailOtpError("invalid-code")` on a
   * wrong/expired code.
   */
  verifyEmailOtp(email: string, code: string): Promise<AuthSession>

  signOut(): Promise<void>
  deleteAccount(): Promise<void>

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
   * Same forced refresh as {@link refreshTokens}, returning the new access
   * token instead of the session. Exists for the 401 interceptor, which needs
   * the bearer to put on the replayed request and must not fall back to
   * `getAccessToken()` — that one is gated on the local clock and would hand
   * back the very token the server just rejected. Shares the refresh mutex,
   * so concurrent callers of either method make one `/auth/refresh` call.
   */
  refreshAccessToken(): Promise<string | null>

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

/** Discriminates the recoverable failures of `AuthPort.deleteAccount`. */
export type AccountDeleteErrorKind =
  | "already-deleted"
  | "rate-limited"
  | "server"
  | "network"
  | "unauthorized"
  | "unknown"

/**
 * Thrown by `AuthPort.deleteAccount` on a non-success outcome. Lives on
 * the port (not the concrete adapter) so views/stores can branch on
 * `kind` without importing the capacitor implementation. Mirrors the
 * `PurchaseCancelledError` sentinel on the purchases port.
 */
export class AccountDeleteError extends Error {
  constructor(
    public readonly kind: AccountDeleteErrorKind,
    public readonly status?: number
  ) {
    super(`account/delete: ${kind}${status ? ` (${status})` : ""}`)
    this.name = "AccountDeleteError"
  }
}

/** Discriminates the recoverable failures of the email-OTP flow. */
export type EmailOtpErrorKind =
  | "invalid-email"
  | "invalid-code"
  | "throttled"
  | "disabled"
  | "network"
  | "server"
  | "unknown"

/**
 * Thrown by `AuthPort.requestEmailOtp` / `verifyEmailOtp` on a non-success
 * outcome. Lives on the port (not the adapter) so views/stores can branch
 * on `kind` without importing the capacitor implementation. Mirrors
 * `AccountDeleteError`.
 */
export class EmailOtpError extends Error {
  constructor(
    public readonly kind: EmailOtpErrorKind,
    /** Seconds to wait before retrying, from the server's Retry-After. */
    public readonly retryAfter?: number
  ) {
    super(`email-otp: ${kind}`)
    this.name = "EmailOtpError"
  }
}

export interface AuthConfig {
  /**
   * HTTP call to the auth service. `path` is relative (e.g. `/me`,
   * `/signin/google`); the implementation prepends the active server's
   * base URL and handles failover to other servers on transient errors.
   * The composition root wires this through `createFailoverClient` so
   * an unreachable preferred server transparently falls through to
   * others — and Settings reflects a promoted fallback automatically.
   */
  request: (path: string, init?: RequestInit) => Promise<Response>
  /** Google OAuth web client ID (used by capgo on Android & Web). */
  googleWebClientId: string
  /** Google OAuth iOS client ID. */
  googleIOSClientId: string
  /** Current UI locale, sent with the email-OTP request so the code email is
   *  localized. Optional; the server falls back to English. */
  getLocale?: () => string
}
