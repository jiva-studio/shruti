import { Capacitor } from "@capacitor/core"
import { Device } from "@capacitor/device"
import { Preferences } from "@capacitor/preferences"
import { SocialLogin } from "@capgo/capacitor-social-login"

import {
  AccountDeleteError,
  EmailOtpError,
  type AuthConfig,
  type AuthPort,
  type AuthSession,
  type MeView,
} from "@ports/app/auth.js"

interface StoredTokens {
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
  // JWT `quota_id` claim — server-side rate-limit bucket id. Empty
  // string on pre-PR-1 tokens (anon users without a stable hash).
  quotaId: string
}

const PREFERENCES_KEY = "auth.tokens"

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// Backoff schedule for the anonymous-bootstrap retry. The endpoint is the
// app's identity floor — if it fails the user has NO token and the whole
// app (chat especially) is dead — so we retry transient failures instead
// of stranding token-less until the next manual restart. One extra event
// per attempt is well within the edge's per-IP budget.
const ANON_RETRY_BACKOFF_MS = [400, 1200, 3000]

interface TokenResponseBody {
  accessToken: string
  refreshToken: string
  userId: string
  anonymous: boolean
}

interface MeBody {
  userId: string
  email: string | null
  name: string | null
  pictureUrl: string | null
  anonymous: boolean
  tier?: string
  tierExpiresAt?: string | null
}

/**
 * Single-adapter implementation of AuthPort. Works on native (Android/iOS)
 * via @capgo/capacitor-social-login; on web the social-login path returns
 * null gracefully (used for in-browser dev only — there's no Welcome flow
 * outside the app).
 */
export function useCapacitorAuth(cfg: AuthConfig): AuthPort {
  let session: AuthSession | null = null
  let stored: StoredTokens | null = null
  let refreshInFlight: Promise<string | null> | null = null
  // Coalesces concurrent anonymous bootstraps (boot + a chat send racing
  // it, or several callers hitting getAccessToken() after a session loss)
  // behind a single /auth/anonymous round-trip — same pattern as
  // refreshInFlight. Without it a token-less app could fire N mint calls.
  let bootstrapInFlight: Promise<AuthSession> | null = null
  let socialInitialized = false
  const listeners = new Set<(s: AuthSession | null) => void>()

  function setSession(s: AuthSession | null): void {
    session = s
    for (const l of listeners) l(s)
  }

  async function loadTokens(): Promise<StoredTokens | null> {
    const { value } = await Preferences.get({ key: PREFERENCES_KEY })
    if (!value) return null
    try {
      return JSON.parse(value) as StoredTokens
    } catch {
      return null
    }
  }

  async function persistTokens(t: StoredTokens): Promise<void> {
    stored = t
    await Preferences.set({ key: PREFERENCES_KEY, value: JSON.stringify(t) })
  }

  async function clearTokens(): Promise<void> {
    stored = null
    setSession(null)
    await Preferences.remove({ key: PREFERENCES_KEY })
  }

  function decodeAccessClaims(accessToken: string): {
    expMs: number
    tier: string
    tierExpiresAtMs: number | null
    quotaId: string
  } {
    try {
      const [, payloadB64] = accessToken.split(".")
      const json = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")))
      // JWT carries tier_expires_at as UNIX seconds; 0 / missing means
      // lifetime Pro or free — expose as null so the store's `tier`
      // getter never coerces by date in those cases.
      const rawExp = typeof json.tier_expires_at === "number" ? json.tier_expires_at : 0
      return {
        expMs: typeof json.exp === "number" ? json.exp * 1000 : 0,
        tier: typeof json.tier === "string" ? json.tier : "free",
        tierExpiresAtMs: rawExp > 0 ? rawExp * 1000 : null,
        // PR-1 made anonymous quota_id always non-empty (device-subject
        // hash); pre-PR-1 tokens collapsed anon users to "". Treat
        // missing/malformed as "" so consumers can fall back gracefully.
        quotaId: typeof json.quota_id === "string" ? json.quota_id : "",
      }
    } catch {
      return { expMs: 0, tier: "free", tierExpiresAtMs: null, quotaId: "" }
    }
  }

  function sessionFromTokens(t: StoredTokens): AuthSession {
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

  async function fetchMeBody(accessToken: string): Promise<MeBody | null> {
    try {
      const res = await cfg.request("/me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) return null
      return (await res.json()) as MeBody
    } catch {
      return null
    }
  }

  async function commitTokenResponse(body: TokenResponseBody): Promise<AuthSession> {
    const me = await fetchMeBody(body.accessToken)
    const claims = decodeAccessClaims(body.accessToken)
    // tier_expires_at: JWT claim wins (integer epoch), /me's ISO string
    // is the tie-breaker for pre-1.7 tokens that lack the JWT claim.
    let tierExpiresAt = claims.tierExpiresAtMs
    if (tierExpiresAt === null && me?.tierExpiresAt) {
      const parsed = Date.parse(me.tierExpiresAt)
      tierExpiresAt = Number.isFinite(parsed) ? parsed : null
    }
    const next: StoredTokens = {
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      userId: body.userId,
      email: me?.email ?? null,
      name: me?.name ?? null,
      picture: me?.pictureUrl ?? null,
      anonymous: body.anonymous,
      accessTokenExpiresAt: claims.expMs,
      // Trust the JWT claim primarily — /me is best-effort, JWT is what
      // the chat service will actually see. /me's `tier` is a tie-breaker
      // when JWT lacks the claim (older tokens in flight).
      tier: claims.tier || me?.tier || "free",
      tierExpiresAt,
      quotaId: claims.quotaId,
    }
    await persistTokens(next)
    const sess = sessionFromTokens(next)
    setSession(sess)
    return sess
  }

  async function ensureSocialInit(): Promise<void> {
    if (socialInitialized) return
    socialInitialized = true
    try {
      await SocialLogin.initialize({
        google: {
          webClientId: cfg.googleWebClientId,
          iOSClientId: cfg.googleIOSClientId,
        },
      })
    } catch (e) {
      console.warn("[auth] social-login init failed", e)
    }
  }

  async function callAnonymous(): Promise<TokenResponseBody> {
    const deviceId = (await Device.getId()).identifier
    const platform = Capacitor.getPlatform()
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(stored?.accessToken ? { Authorization: `Bearer ${stored.accessToken}` } : {}),
      },
      body: JSON.stringify({ deviceId, platform }),
    }
    // Attempt once + retry transient failures. A 429 (edge per-IP burst),
    // a 5xx (auth mid-deploy / DB blip) or a network error are all
    // recoverable on a later try; any other 4xx (e.g. 400 bad request) is
    // a real client error and fails fast.
    let lastErr: unknown
    for (let attempt = 0; attempt <= ANON_RETRY_BACKOFF_MS.length; attempt++) {
      let res: Response
      try {
        res = await cfg.request("/anonymous", init)
      } catch (e) {
        lastErr = e
        if (attempt === ANON_RETRY_BACKOFF_MS.length) break
        await sleep(ANON_RETRY_BACKOFF_MS[attempt])
        continue
      }
      if (res.ok) return (await res.json()) as TokenResponseBody
      const transient = res.status === 429 || res.status === 408 || res.status >= 500
      if (!transient) throw new Error(`auth/anonymous: HTTP ${res.status}`)
      lastErr = new Error(`auth/anonymous: HTTP ${res.status}`)
      if (attempt === ANON_RETRY_BACKOFF_MS.length) break
      await sleep(ANON_RETRY_BACKOFF_MS[attempt])
    }
    throw lastErr ?? new Error("auth/anonymous: retries exhausted")
  }

  // Coalesced anonymous bootstrap. The anonymous identity is the app's
  // floor (signed-out users live here, Spotify-free style), so any code
  // path that finds itself token-less can fall back through here instead
  // of giving up until the next app restart.
  function readAccessToken(): string | null {
    return stored?.accessToken ?? null
  }

  function bootstrapAnonymous(): Promise<AuthSession> {
    if (!bootstrapInFlight) {
      bootstrapInFlight = (async () => {
        try {
          const tokens = await callAnonymous()
          return await commitTokenResponse(tokens)
        } finally {
          bootstrapInFlight = null
        }
      })()
    }
    return bootstrapInFlight
  }

  // A refresh attempt has three outcomes, not two: success, a genuine
  // rejection (the token is bad/expired/revoked → drop the session), and a
  // transient failure (backend mid-deploy, rate-limit, offline → keep the
  // session and retry later). Collapsing the last two into "logout" is what
  // makes users get signed out after an app/backend update.
  type RefreshOutcome = { ok: true; body: TokenResponseBody } | { ok: false; rejected: boolean }

  async function callRefresh(refreshToken: string): Promise<RefreshOutcome> {
    let res: Response
    try {
      res = await cfg.request("/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      })
    } catch {
      // Network error / offline — transient, never drop the session.
      return { ok: false, rejected: false }
    }
    if (res.ok) return { ok: true, body: (await res.json()) as TokenResponseBody }
    // 401/403 = the server rejected the refresh token itself → clear.
    // 5xx (auth/DB down during a deploy), 429, 408, etc. are transient →
    // keep the session so a later attempt can recover.
    return { ok: false, rejected: res.status === 401 || res.status === 403 }
  }

  async function callSignin(
    provider: "google" | "apple",
    idToken: string,
    fullName?: string
  ): Promise<TokenResponseBody> {
    const res = await cfg.request(`/signin/${provider}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(stored?.accessToken ? { Authorization: `Bearer ${stored.accessToken}` } : {}),
      },
      body: JSON.stringify({ idToken, ...(fullName ? { fullName } : {}) }),
    })
    if (!res.ok) throw new Error(`auth/signin/${provider}: HTTP ${res.status}`)
    return (await res.json()) as TokenResponseBody
  }

  // A thrown request is only a CONNECTIVITY failure when the request never
  // reached a responding server. `withNetworkErrorContext` (composition root)
  // renames fetch's `TypeError: Failed to fetch` to a `NetworkError`; match by
  // name so this adapter needn't import the app-layer class. A raw `TypeError`
  // is covered too, in case a caller wires an unwrapped request fn. Everything
  // else — notably the failover client throwing `Error("HTTP 5xx")` when every
  // server is transiently down — is a SERVER fault, not the user's internet,
  // and must NOT surface as "check your connection".
  function isConnectivityError(e: unknown): boolean {
    if ((e as { name?: unknown } | null)?.name === "NetworkError") return true
    return e instanceof TypeError
  }

  function emailOtpErrorFromResponse(res: Response): EmailOtpError {
    const retryAfter = Number(res.headers.get("Retry-After")) || undefined
    switch (res.status) {
      case 400:
        return new EmailOtpError("invalid-email")
      case 401:
        return new EmailOtpError("invalid-code")
      case 429:
        return new EmailOtpError("throttled", retryAfter)
      case 503:
        return new EmailOtpError("disabled")
      default:
        return new EmailOtpError(res.status >= 500 ? "server" : "unknown")
    }
  }

  async function requestEmailOtp(email: string): Promise<void> {
    let res: Response
    try {
      res = await cfg.request("/signin/email/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // An anonymous bearer lets the server upgrade THIS device's user
          // in place on the subsequent verify (same userId / progress).
          ...(stored?.accessToken ? { Authorization: `Bearer ${stored.accessToken}` } : {}),
        },
        body: JSON.stringify({ email, locale: cfg.getLocale?.() ?? "" }),
      })
    } catch (e) {
      throw new EmailOtpError(isConnectivityError(e) ? "network" : "server")
    }
    if (res.ok) return
    throw emailOtpErrorFromResponse(res)
  }

  async function verifyEmailOtp(email: string, code: string): Promise<AuthSession> {
    const deviceId = (await Device.getId()).identifier
    let res: Response
    try {
      res = await cfg.request("/signin/email/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(stored?.accessToken ? { Authorization: `Bearer ${stored.accessToken}` } : {}),
        },
        body: JSON.stringify({ email, code, deviceId }),
      })
    } catch (e) {
      throw new EmailOtpError(isConnectivityError(e) ? "network" : "server")
    }
    if (!res.ok) throw emailOtpErrorFromResponse(res)
    return commitTokenResponse((await res.json()) as TokenResponseBody)
  }

  /**
   * Call `/auth/refresh` and return the new access token, coalescing
   * concurrent callers behind a single round-trip. The ONLY place tokens are
   * rotated: the lazy path in `getAccessToken`, the tier-driven
   * `refreshTokens`, and the 401 interceptor's `refreshAccessToken` all end
   * up here, so they share one mutex instead of three.
   */
  function forceRefresh(): Promise<string | null> {
    if (!stored) return Promise.resolve(null)
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const r = await callRefresh(stored!.refreshToken)
          if (!r.ok) {
            // Only a genuine rejection drops the session; a transient
            // failure leaves `stored` intact so the next call retries.
            if (r.rejected) await clearTokens()
            return null
          }
          // Return the freshly-minted token from the response, not a
          // re-read of module-level `stored` — a concurrent clearTokens()
          // could null `stored` between the await and the read, rejecting
          // every coalesced caller with a TypeError.
          await commitTokenResponse(r.body)
          return r.body.accessToken
        } finally {
          refreshInFlight = null
        }
      })()
    }
    return refreshInFlight
  }

  // ─── AuthPort ─────────────────────────────────────────────────────────

  async function initialize(): Promise<AuthSession> {
    stored = await loadTokens()
    if (stored) {
      // Optimistically expose the persisted session; refresh is lazy and
      // happens on getAccessToken() if expiring.
      const sess = sessionFromTokens(stored)
      setSession(sess)
      return sess
    }
    return bootstrapAnonymous()
  }

  async function getAccessToken(): Promise<string | null> {
    if (!stored) {
      // No session — the boot bootstrap failed (offline / 429 storm) or a
      // refresh rejection cleared our tokens mid-run. Re-mint the anonymous
      // identity rather than handing back null forever: otherwise the app
      // stays token-less (chat hangs on "Thinking…") until a manual restart
      // — and a restart only retries once. Falls through to null only if the
      // bootstrap itself (with its own retries) ultimately fails.
      try {
        await bootstrapAnonymous()
      } catch (e) {
        console.warn("[auth] anonymous bootstrap recovery failed", e)
        return null
      }
      // Read through a helper: `stored` is narrowed to null by the guard
      // above and TS keeps that across the await, even though
      // bootstrapAnonymous() repopulated it via commitTokenResponse.
      return readAccessToken()
    }
    const now = Date.now()
    if (stored.accessTokenExpiresAt - now > 60_000) {
      return stored.accessToken
    }
    return forceRefresh()
  }

  async function signInWithGoogle(): Promise<AuthSession | null> {
    await ensureSocialInit()
    let result
    try {
      result = await SocialLogin.login({ provider: "google", options: {} })
    } catch (e) {
      console.warn("[auth] google login canceled or failed", e)
      return null
    }
    if (result.provider !== "google" || result.result?.responseType !== "online") return null
    const idToken = result.result.idToken
    if (!idToken) return null
    const tokens = await callSignin("google", idToken)
    return commitTokenResponse(tokens)
  }

  async function signInWithApple(): Promise<AuthSession | null> {
    await ensureSocialInit()
    let result
    try {
      result = await SocialLogin.login({ provider: "apple", options: {} })
    } catch (e: unknown) {
      // 1001 = user canceled; 1000 = connectivity / unknown
      const msg = String((e as { errorMessage?: string } | null)?.errorMessage ?? "")
      if (msg.includes("1001") || msg.includes("1000")) return null
      console.warn("[auth] apple login failed", e)
      throw e
    }
    if (result.provider !== "apple") return null
    const idToken = result.result?.idToken
    if (!idToken) return null
    const { givenName, familyName } = result.result.profile ?? {}
    const fullName = [givenName, familyName].filter(Boolean).join(" ").trim() || undefined
    const tokens = await callSignin("apple", idToken, fullName)
    return commitTokenResponse(tokens)
  }

  async function signOut(): Promise<void> {
    if (!stored) return
    try {
      await cfg.request("/signout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${stored.accessToken}`,
        },
        body: JSON.stringify({ refreshToken: stored.refreshToken }),
      })
    } catch {
      // Network failure — still drop tokens locally; server-side refresh
      // will become orphaned but harmless.
    }
    try {
      await SocialLogin.logout({ provider: "google" }).catch(() => undefined)
      await SocialLogin.logout({ provider: "apple" }).catch(() => undefined)
    } catch {
      /* best-effort */
    }
    await clearTokens()
  }

  async function deleteAccount(): Promise<void> {
    if (!stored) return
    // CRITICAL: only clear local tokens after the server confirms the
    // deletion. The upstream caller follows up with wipeLocalUserData()
    // when wipeLocal=true; if we cleared on a 5xx the user would lose
    // notes/chats/downloads while their server account still exists.
    const doDelete = async (token: string): Promise<Response> => {
      try {
        return await cfg.request("/account/delete", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        })
      } catch {
        throw new AccountDeleteError("network")
      }
    }

    // Capture the identity we're deleting so the 401-retry below can't
    // accidentally delete a *different* account if the session was swapped
    // (signout→re-bootstrap, switch-account) between the two calls.
    const targetUserId = stored.userId
    let res = await doDelete(stored.accessToken)
    if (res.status === 401) {
      // Stale access token — try one refresh + retry. getAccessToken()
      // handles the refresh-coalesce and clears tokens on refresh
      // failure, so a null return means the session is already gone.
      const refreshed = await getAccessToken()
      if (!refreshed) throw new AccountDeleteError("unauthorized", 401)
      // Bail if the refresh landed on a different identity than the one we
      // set out to delete — retrying would wipe the wrong account.
      if (stored?.userId !== targetUserId) {
        throw new AccountDeleteError("unauthorized", 401)
      }
      res = await doDelete(refreshed)
      if (res.status === 401) throw new AccountDeleteError("unauthorized", 401)
    }
    if (!res.ok) {
      if (res.status === 410) {
        // Server says the account is already gone — drop local tokens
        // so the caller's wipe/restore lands on a clean anonymous slate.
        await clearTokens()
        throw new AccountDeleteError("already-deleted", 410)
      }
      if (res.status === 429) throw new AccountDeleteError("rate-limited", 429)
      if (res.status >= 500) throw new AccountDeleteError("server", res.status)
      throw new AccountDeleteError("unknown", res.status)
    }
    await clearTokens()
  }

  function getSession(): AuthSession | null {
    return session
  }

  function onSessionChange(listener: (s: AuthSession | null) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function refreshTokens(): Promise<AuthSession | null> {
    // Coalesces with the lazy-refresh path so a foreground sync that races a
    // getAccessToken() doesn't fire /auth/refresh twice.
    const tok = await forceRefresh()
    // `session` is the just-committed session unless a concurrent
    // clearTokens() raced in and nulled it — return it as-is (null = the
    // session was cleared, which the caller handles gracefully).
    if (!tok) return null
    return session
  }

  function refreshAccessToken(): Promise<string | null> {
    return forceRefresh()
  }

  async function fetchMe(): Promise<MeView | null> {
    const tok = await getAccessToken()
    if (!tok) return null
    const me = await fetchMeBody(tok)
    if (!me) return null
    return {
      tier: me.tier ?? "free",
      tierExpiresAt: me.tierExpiresAt ? Date.parse(me.tierExpiresAt) : null,
    }
  }

  return {
    initialize,
    signInWithGoogle,
    signInWithApple,
    requestEmailOtp,
    verifyEmailOtp,
    signOut,
    deleteAccount,
    getSession,
    getAccessToken,
    refreshTokens,
    refreshAccessToken,
    fetchMe,
    onSessionChange,
  }
}
