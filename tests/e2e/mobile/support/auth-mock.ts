import { expect, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test"

/**
 * The auth service, stood up as route mocks.
 *
 * Every spec that touches identity used to hand-roll its own `page.route`
 * blocks — six of them minted their own JWT, three shaped their own `/auth/me`
 * — and the four endpoints the email sign-in journey actually uses
 * (`signin/email/request`, `signin/email/verify`, `signout`, `account/delete`)
 * had no mock at all, so they landed on the loopback sink and no spec could
 * drive them.
 *
 * Shapes here follow `modules/services/auth/internal/handler/` — the token
 * response (`sessionToResp`), the `/auth/me` projection (`profile.MeUser`) and
 * the error envelope (`writeErr`) — so a spec asserts against what the server
 * really sends rather than a convenient invention.
 *
 * Every mock is registered at PAGE level, which Playwright matches before the
 * context-level defaults in `support/test.ts`, so a spec's mock always wins
 * over {@link installDefaultAnonymousAuth}.
 */

/** The user id every mocked session is minted for. */
export const E2E_USER_ID = "u-e2e"

/* --------------------------------- bodies --------------------------------- */

export interface JwtClaims {
  /** Seconds from now until `exp`. Negative for an already-expired token. */
  expiresInSec?: number
  /** JWT subject — the user id. Read back by {@link mockEmailOtpVerify}. */
  sub?: string
  tier?: string
  /** UNIX seconds. Omitted entirely when absent (= lifetime Pro or free). */
  tierExpiresAtSec?: number
  quotaId?: string
}

/**
 * Mint an unsigned JWT whose base64 middle carries the claims the client reads
 * (`exp`, `tier`, `tier_expires_at`, `quota_id` — see `decodeAccessClaims` in
 * `infra/auth/capacitor/useCapacitorAuth.ts`). The client never verifies the
 * signature, so the header and signature segments are placeholders.
 *
 * `sub` is not read by the client, but a real token carries it and the verify
 * mock uses it to model the server's in-place anonymous upgrade.
 */
export function jwt(claims: JwtClaims = {}): string {
  const { expiresInSec = 3600, sub = E2E_USER_ID, tier = "free", quotaId = "q-e2e" } = claims
  const payload = {
    sub,
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    tier,
    quota_id: quotaId,
    ...(claims.tierExpiresAtSec ? { tier_expires_at: claims.tierExpiresAtSec } : {}),
  }
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64")}.s`
}

/** The token response shared by `/auth/anonymous`, `/auth/refresh` and both
 *  sign-in endpoints (`sessionToResp`). */
export interface TokenBody {
  accessToken: string
  refreshToken: string
  userId: string
  anonymous: boolean
}

/** A token response, defaulting to a signed-in session for {@link E2E_USER_ID}.
 *  The access token is minted to match `userId` unless one is passed. */
export function tokenBody(over: Partial<TokenBody> = {}): TokenBody {
  const userId = over.userId ?? E2E_USER_ID
  return {
    accessToken: over.accessToken ?? jwt({ sub: userId }),
    refreshToken: over.refreshToken ?? "e2e-refresh",
    userId,
    anonymous: over.anonymous ?? false,
  }
}

/** One row of `/auth/me`'s `identities` (`profile.MeIdentity`). */
export interface MeIdentity {
  provider: string
  subject: string
  email: string | null
  emailVerified: boolean
  createdAt: string
}

/** The `/auth/me` projection (`profile.MeUser`). `email` / `name` /
 *  `pictureUrl` keep their keys and render as null — the RU profile policy
 *  nulls them by design, and the client's `name ?? email ?? signedIn` fallback
 *  depends on the keys being present. */
export interface MeBody {
  userId: string
  anonymous: boolean
  createdAt: string
  tier: string
  /** ISO-8601, or null for lifetime Pro / free. Omitted by the server. */
  tierExpiresAt?: string | null
  email: string | null
  name: string | null
  pictureUrl: string | null
  identities: MeIdentity[]
}

/** An `/auth/me` body, anonymous and profile-less by default. */
export function meBody(over: Partial<MeBody> = {}): MeBody {
  return {
    userId: over.userId ?? E2E_USER_ID,
    anonymous: over.anonymous ?? true,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00Z",
    tier: over.tier ?? "free",
    ...(over.tierExpiresAt === undefined ? {} : { tierExpiresAt: over.tierExpiresAt }),
    email: over.email ?? null,
    name: over.name ?? null,
    pictureUrl: over.pictureUrl ?? null,
    identities: over.identities ?? [],
  }
}

/** The identity row an email sign-in adds to `/auth/me`. */
export function emailIdentity(email: string): MeIdentity {
  return {
    provider: "email",
    subject: email,
    email,
    emailVerified: true,
    createdAt: "2026-01-01T00:00:00Z",
  }
}

/* -------------------------------- recording ------------------------------- */

/** One intercepted request, as the client sent it. */
export interface SeenRequest {
  /** The Bearer the client attached, or null when it sent none. The anonymous
   *  bearer on `signin/email/*` is what lets the server upgrade this device's
   *  user in place instead of minting a second account. */
  bearer: string | null
  /** The parsed JSON body — `{}` for a GET or an empty post. */
  body: Record<string, unknown>
}

/** Live view of what one endpoint has been asked. */
export interface Recorder {
  readonly count: number
  readonly seen: readonly SeenRequest[]
  readonly last: SeenRequest | undefined
}

function bearerOf(route: Route): string | null {
  const header = route.request().headers()["authorization"]
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null
}

function bodyOf(route: Route): Record<string, unknown> {
  const raw = route.request().postData()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Claims out of a token the CLIENT sent us — the mock's stand-in for the
 *  server reading the bearer it was handed. */
export function claimsOf(token: string | null): Record<string, unknown> {
  if (!token) return {}
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64").toString()) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

/** An answer, either fixed or chosen per call (1-based). */
type Reply<T> = T | ((call: number) => T)

async function serve<T>(
  page: Page,
  pattern: string,
  reply: Reply<T>,
  fulfil: (route: Route, answer: T, seen: SeenRequest) => Promise<void> | void
): Promise<Recorder> {
  const seen: SeenRequest[] = []
  await page.route(pattern, async (route) => {
    const request: SeenRequest = { bearer: bearerOf(route), body: bodyOf(route) }
    seen.push(request)
    const answer = typeof reply === "function" ? (reply as (c: number) => T)(seen.length) : reply
    await fulfil(route, answer, request)
  })
  return {
    get count() {
      return seen.length
    },
    get seen() {
      return seen
    },
    get last() {
      return seen[seen.length - 1]
    },
  }
}

function json(route: Route, status: number, body: unknown, headers?: Record<string, string>): void {
  void route.fulfill({
    status,
    contentType: "application/json",
    headers,
    body: JSON.stringify(body),
  })
}

/** The server's error envelope (`writeErr`). */
function err(route: Route, status: number, code: string, headers?: Record<string, string>): void {
  json(route, status, { error: { code, message: code } }, headers)
}

/* -------------------------------- endpoints ------------------------------- */

export type MeReply = { ok: true; user?: Partial<MeBody> } | { ok: false; status: number }

/** `GET /auth/me` — the profile projection behind every token commit. */
export function mockMe(page: Page, reply: Reply<MeReply> = { ok: true }): Promise<Recorder> {
  return serve(page, "**/auth/me", reply, (route, answer) => {
    if (!answer.ok) return err(route, answer.status, "me_failed")
    json(route, 200, meBody(answer.user))
  })
}

export type RefreshReply =
  | { ok: true; tokens?: Partial<TokenBody> }
  /** 401/403 = the refresh token itself was rejected → the client drops the
   *  session. Anything else is transient and the session must survive it —
   *  though a 5xx never reaches the adapter as a status: the region failover
   *  client exhausts its servers and throws, so the adapter handles it in
   *  `callRefresh`'s catch rather than its status branch. */
  | { ok: false; status: number }

/** `POST /auth/refresh`. */
export function mockRefresh(page: Page, reply: Reply<RefreshReply>): Promise<Recorder> {
  return serve(page, "**/auth/refresh", reply, (route, answer) => {
    if (!answer.ok) return err(route, answer.status, "refresh_failed")
    json(route, 200, tokenBody(answer.tokens))
  })
}

export type OtpRequestReply =
  | { ok: true }
  /** 400 invalid email, 429 throttled (with `Retry-After`), 503 mail disabled. */
  | { ok: false; status: number; retryAfter?: number }

/**
 * `POST /auth/signin/email/request`.
 *
 * Success is `200 {}`, not the 204 the issue sketched — see `requestEmailOTP`.
 * The client only reads `res.ok`, so the distinction is invisible to it, but
 * the mock follows the handler.
 */
export function mockEmailOtpRequest(
  page: Page,
  reply: Reply<OtpRequestReply> = { ok: true }
): Promise<Recorder> {
  return serve(page, "**/auth/signin/email/request", reply, (route, answer) => {
    if (answer.ok) return json(route, 200, {})
    const code =
      answer.status === 429
        ? "otp_throttled"
        : answer.status === 400
          ? "invalid_email"
          : "otp_error"
    err(
      route,
      answer.status,
      code,
      answer.retryAfter ? { "Retry-After": String(answer.retryAfter) } : undefined
    )
  })
}

export type OtpVerifyReply =
  | { ok: true; tokens?: Partial<TokenBody> }
  /** 401 = invalid or expired code; 400 invalid email; 503 mail disabled. */
  | { ok: false; status: number }

/**
 * True when the mock, standing in for `s.Verifier.Verify(bearer)`, can identify
 * a user from this token. Presence is not enough: an EXPIRED bearer fails
 * verification server-side, which is what drops the request out of the
 * "anonymous bearer in play → upgrade that user" branch (#1737).
 */
function verifiableSubject(bearer: string | null): string | null {
  const claims = claimsOf(bearer)
  if (typeof claims.sub !== "string") return null
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) return null
  return claims.sub
}

/**
 * `POST /auth/signin/email/verify`.
 *
 * On success it models the server's in-place upgrade: the session it returns
 * belongs to the user id in the anonymous bearer the client attached, now
 * non-anonymous. A client that forgot the bearer — or sent one the server
 * cannot verify — therefore gets a DIFFERENT id back, which is what makes "the
 * upgrade preserved my userId" an assertion that can fail.
 */
export function mockEmailOtpVerify(
  page: Page,
  reply: Reply<OtpVerifyReply> = { ok: true }
): Promise<Recorder> {
  return serve(page, "**/auth/signin/email/verify", reply, (route, answer, seen) => {
    if (!answer.ok) return err(route, answer.status, "otp_invalid")
    const upgraded = verifiableSubject(seen.bearer) ?? "u-fresh-account"
    json(route, 200, tokenBody({ userId: upgraded, ...answer.tokens, anonymous: false }))
  })
}

export type SignOutReply = { ok: true } | { ok: false; status: number }

/** `POST /auth/signout`. */
export function mockSignOut(
  page: Page,
  reply: Reply<SignOutReply> = { ok: true }
): Promise<Recorder> {
  return serve(page, "**/auth/signout", reply, (route, answer) => {
    if (!answer.ok) return err(route, answer.status, "signout_failed")
    json(route, 200, {})
  })
}

export type AccountDeleteReply =
  | { ok: true }
  /** 401 stale token (the client refreshes and retries once), 410
   *  `already_deleted`, 429 cooldown, 5xx. */
  | { ok: false; status: number; code?: string }

/** `POST /auth/account/delete`. */
export function mockAccountDelete(
  page: Page,
  reply: Reply<AccountDeleteReply> = { ok: true }
): Promise<Recorder> {
  return serve(page, "**/auth/account/delete", reply, (route, answer) => {
    if (answer.ok) return json(route, 200, {})
    const code = answer.code ?? (answer.status === 410 ? "already_deleted" : "delete_failed")
    err(route, answer.status, code)
  })
}

/* ------------------------------ stored session ----------------------------- */

/** `StoredTokens` as the adapter persists it (Capacitor Preferences →
 *  localStorage under the `CapacitorStorage.` prefix on web). */
export interface StoredSession {
  accessToken: string
  refreshToken: string
  userId: string
  email: string | null
  name: string | null
  picture: string | null
  anonymous: boolean
  accessTokenExpiresAt: number
  tier: string
  tierExpiresAt: number | null
  quotaId: string
}

/** Where the adapter keeps the session. */
export const TOKENS_STORAGE_KEY = "CapacitorStorage.auth.tokens"

/**
 * Seed a persisted session before boot, so a spec starts from a signed-in app
 * without a backend. Call BEFORE `boot()`.
 *
 * `expiresInSec` decides which refresh path the run takes: an hour out and
 * nothing proactive can fire (only a server 401 produces a refresh), under 60s
 * and the next authed call refreshes first. Both matter, so the spec says which
 * one it means instead of inheriting a default.
 */
export async function preseedSession(
  page: Page,
  over: Partial<StoredSession> & { expiresInSec?: number } = {}
): Promise<void> {
  const expiresInSec = over.expiresInSec ?? 3600
  const userId = over.userId ?? E2E_USER_ID
  const tier = over.tier ?? "free"
  const quotaId = over.quotaId ?? "q1"
  const session: StoredSession = {
    accessToken: over.accessToken ?? jwt({ expiresInSec, sub: userId, tier, quotaId }),
    refreshToken: over.refreshToken ?? "e2e-refresh",
    userId,
    email: over.email === undefined ? "e2e@example.com" : over.email,
    name: over.name === undefined ? "E2E Tester" : over.name,
    picture: over.picture ?? null,
    anonymous: over.anonymous ?? false,
    accessTokenExpiresAt: over.accessTokenExpiresAt ?? Date.now() + expiresInSec * 1000,
    tier,
    tierExpiresAt: over.tierExpiresAt ?? null,
    quotaId,
  }
  await page.addInitScript(
    ({ key, value }: { key: string; value: string }) => {
      try {
        localStorage.setItem(key, value)
      } catch {
        /* unavailable origin — non-fatal */
      }
    },
    { key: TOKENS_STORAGE_KEY, value: JSON.stringify(session) }
  )
}

/* ---------------------------- anonymous identity --------------------------- */

/** The anonymous session handed to the app in place of a real one. */
function anonymousSession(tier: "free" | "pro"): string {
  return JSON.stringify(
    tokenBody({ accessToken: jwt({ tier }), anonymous: true, refreshToken: "e2e-refresh" })
  )
}

export type AnonymousReply = { ok: true; tier?: "free" | "pro" } | { ok: false; status: number }

/**
 * `POST /auth/anonymous`, recorded.
 *
 * The suite already answers this endpoint by default (below), but the default
 * cannot be counted — and how many times the app minted an identity is exactly
 * what separates "kept the session" from "silently signed the user out and
 * started over". Take this when a spec needs to assert that number.
 */
export function mockAnonymous(
  page: Page,
  reply: Reply<AnonymousReply> = { ok: true }
): Promise<Recorder> {
  return serve(page, "**/auth/anonymous", reply, (route, answer) => {
    if (!answer.ok) return err(route, answer.status, "anonymous_failed")
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: anonymousSession(answer.tier ?? "free"),
    })
  })
}

/**
 * Suite-wide default for `POST /auth/anonymous`, installed for every spec by
 * the auto fixture in `support/test.ts`.
 *
 * This is the endpoint that mints accounts, and only 9 of 89 specs used to mock
 * it — the other 80 created a real production user on every run. Making it a
 * default rather than an opt-in is the whole point: an opt-in guard only covers
 * the specs that remembered it.
 *
 * Registered at CONTEXT level, which Playwright matches *after* page-level
 * routes, so {@link mockChatAuth} and any spec's own `page.route` still win.
 *
 * Deliberately narrow: `/auth/me` and `/auth/refresh` are NOT defaulted. They
 * describe *which* session the app has, and a blanket anonymous answer would
 * contradict the specs that seed a signed-in one (`preseedAuthTokens`,
 * `auth-refresh`). Those endpoints can no longer leak either — the mocked
 * region points them at the dead loopback sink.
 */
export async function installDefaultAnonymousAuth(context: BrowserContext): Promise<void> {
  await context.route("**/auth/anonymous", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: anonymousSession("free"),
    })
  )
}

/** Mock the auth endpoints so the app has an anonymous (or Pro) session offline. */
export async function mockChatAuth(page: Page, tier: "free" | "pro" = "free"): Promise<void> {
  await page.route("**/auth/anonymous", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: anonymousSession(tier),
    })
  )
  await mockMe(page, { ok: true, user: { tier } })
}

/* ----------------------------- email sign-in UI ---------------------------- */

/**
 * The email OTP modal. It is mounted once at the app root (`App.vue`) with
 * `keep-contents-mounted`, so its markup exists from boot — scope every query
 * to it rather than to the page, or the settings row's own "Sign in" heading
 * and the action sheet's buttons come back too.
 */
export function emailSignInModal(page: Page): Locator {
  return page.locator("ion-modal.email-signin-modal")
}

/**
 * Walk an anonymous user from Settings to an open email sign-in modal:
 * account row → provider action sheet → "Continue with email".
 *
 * The sheet is presented imperatively by `useAnonymousSignInFlow`, and the
 * modal only opens once the sheet has fully dismissed — hence waiting on the
 * modal itself rather than on the tap.
 */
export async function openEmailSignIn(page: Page): Promise<void> {
  await page.locator("ion-item", { hasText: "Sign in" }).first().click()
  await page.getByRole("button", { name: "Continue with email" }).click()
  await expect(emailSignInModal(page).locator("input")).toBeVisible({ timeout: 15_000 })
}

/** Type an address into step 1 and tap "Send code". */
export async function submitEmail(page: Page, email: string): Promise<void> {
  const modal = emailSignInModal(page)
  await modal.locator("input").fill(email)
  await modal.getByRole("button", { name: "Send code" }).click()
}

/** Type a code into step 2 and tap "Sign in". */
export async function submitCode(page: Page, code: string): Promise<void> {
  const modal = emailSignInModal(page)
  await modal.locator("input").fill(code)
  await modal.getByRole("button", { name: "Sign in", exact: true }).click()
}

/** The inline error line the modal shows under the field. */
export function signInError(page: Page): Locator {
  return emailSignInModal(page).locator("p.error")
}

/** The auth session as it was persisted to Capacitor Preferences (localStorage
 *  on web) — what survives a restart. */
export async function storedTokens(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("CapacitorStorage.auth.tokens") || "{}") as Record<
        string,
        unknown
      >
  )
}
