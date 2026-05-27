import { Capacitor } from "@capacitor/core"
import { Device } from "@capacitor/device"
import { Preferences } from "@capacitor/preferences"
import { SocialLogin } from "@capgo/capacitor-social-login"

import type { AuthConfig, AuthPort, AuthSession, MeView, MigrationResult } from "@ports/app/auth.js"

export type AccountDeleteErrorKind =
  | "already-deleted"
  | "rate-limited"
  | "server"
  | "network"
  | "unauthorized"
  | "unknown"

export class AccountDeleteError extends Error {
  constructor(
    public readonly kind: AccountDeleteErrorKind,
    public readonly status?: number
  ) {
    super(`account/delete: ${kind}${status ? ` (${status})` : ""}`)
    this.name = "AccountDeleteError"
  }
}

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
  // Server-authoritative home region from /auth/me. Empty string when
  // the response was missing the field (pre-this-PR server) — treated
  // as "no reconcile" by the composition root.
  homeRegion: string
}

const PREFERENCES_KEY = "auth.tokens"

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
  // Always emitted by PR-3.X+ servers; missing on older deployments
  // (treated as "" and the composition root skips reconcile).
  homeRegion?: string
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
      homeRegion: t.homeRegion ?? "",
    }
  }

  async function fetchMeBody(accessToken: string): Promise<MeBody | null> {
    try {
      const res = await fetch(`${cfg.baseUrl()}/me`, {
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
    const serverHomeRegion = me?.homeRegion ?? ""
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
      homeRegion: serverHomeRegion,
    }
    await persistTokens(next)
    const sess = sessionFromTokens(next)
    setSession(sess)
    // Reconcile local activeServer against server truth. Skip when
    // /me didn't carry homeRegion (older server) or when the values
    // already match. The composition root decides what to do.
    if (serverHomeRegion) {
      const localRegion = cfg.currentRegionId()
      if (serverHomeRegion !== localRegion) {
        cfg.onHomeRegionMismatch?.(serverHomeRegion, localRegion)
      }
    }
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
    const res = await fetch(`${cfg.baseUrl()}/anonymous`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(stored?.accessToken ? { Authorization: `Bearer ${stored.accessToken}` } : {}),
      },
      body: JSON.stringify({ deviceId, platform }),
    })
    if (!res.ok) throw new Error(`auth/anonymous: HTTP ${res.status}`)
    return (await res.json()) as TokenResponseBody
  }

  async function callRefresh(refreshToken: string): Promise<TokenResponseBody | null> {
    const res = await fetch(`${cfg.baseUrl()}/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) return null
    return (await res.json()) as TokenResponseBody
  }

  async function callSignin(
    provider: "google" | "apple",
    idToken: string,
    fullName?: string
  ): Promise<TokenResponseBody> {
    const res = await fetch(`${cfg.baseUrl()}/signin/${provider}`, {
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
    const tokens = await callAnonymous()
    return commitTokenResponse(tokens)
  }

  async function getAccessToken(): Promise<string | null> {
    if (!stored) return null
    const now = Date.now()
    if (stored.accessTokenExpiresAt - now > 60_000) {
      return stored.accessToken
    }
    // Coalesce concurrent callers behind a single refresh.
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const tr = await callRefresh(stored!.refreshToken)
          if (!tr) {
            await clearTokens()
            return null
          }
          await commitTokenResponse(tr)
          return stored!.accessToken
        } finally {
          refreshInFlight = null
        }
      })()
    }
    return refreshInFlight
  }

  /**
   * Proactive cross-region probe. Given an OAuth idToken, hits
   * /auth/signin/<provider> with X-Lookup-Only=1 on every known region
   * in parallel and picks the region the account actually lives on:
   *
   *   - Exactly one region with exists=true → that region.
   *   - Multiple regions with exists=true   → prefer currently-active
   *     if it's a hit, else the first hit. Multi-region duplicates are
   *     an edge case (failed migration revoke, etc.) — we don't dialog,
   *     we just pick deterministically. User can change in Settings.
   *   - No region claims the account            → current region (signin
   *     there will create a new account on it).
   *
   * Probes are best-effort: timeouts / network errors degrade silently
   * to "not found" on that region. If getRegions / setActiveServerById
   * aren't wired (test stub, legacy), this collapses to a no-op.
   */
  async function resolveSigninRegion(provider: "google" | "apple", idToken: string): Promise<void> {
    const getRegions = cfg.getRegions
    const setActive = cfg.setActiveServerById
    if (!getRegions || !setActive) return
    const regions = getRegions()
    if (regions.length <= 1) return
    const currentId = cfg.currentRegionId()
    const results = await Promise.all(
      regions.map(async (r) => {
        const probe = await lookupAccount(r.id, provider, idToken)
        return { id: r.id, exists: probe?.exists === true }
      })
    )
    const hits = results.filter((r) => r.exists)
    if (hits.length === 0) return // create new on current
    const target = hits.find((r) => r.id === currentId)?.id ?? hits[0].id
    if (target !== currentId) setActive(target)
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
    // Find the region this OAuth identity already lives on (if any) and
    // flip activeServer to it before signin — so the user doesn't get
    // dropped onto a fresh duplicate account on the wrong region.
    await resolveSigninRegion("google", idToken)
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
    const idToken = result.result?.accessToken?.token
    if (!idToken) return null
    const { givenName, familyName } = result.result.profile ?? {}
    const fullName = [givenName, familyName].filter(Boolean).join(" ").trim() || undefined
    await resolveSigninRegion("apple", idToken)
    const tokens = await callSignin("apple", idToken, fullName)
    return commitTokenResponse(tokens)
  }

  async function completeSigninAfterRetry(
    provider: "google" | "apple",
    idToken: string,
    fullName?: string
  ): Promise<AuthSession> {
    const tokens = await callSignin(provider, idToken, fullName)
    return commitTokenResponse(tokens)
  }

  /**
   * Probe the OTHER region for an existing account using the same
   * X-Lookup-Only signin shortcut. 3s timeout — anything slower than
   * that is treated as uncertainty and the caller surfaces the
   * dup-account-risk warning. Returns null on:
   *   - timeout / network / abort
   *   - resolveAuthBaseUrl rejection (unknown region id)
   *   - non-2xx other than 404
   *   - 200 with malformed body
   */
  async function lookupAccount(
    regionId: string,
    provider: "google" | "apple",
    idToken: string
  ): Promise<{ exists: boolean; anonymous: boolean } | null> {
    let url: string
    try {
      url = cfg.resolveAuthBaseUrl(regionId)
    } catch {
      return null
    }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 3000)
    try {
      const res = await fetch(`${url}/signin/${provider}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Lookup-Only": "1",
        },
        body: JSON.stringify({ idToken }),
        signal: ctl.signal,
      })
      if (res.status === 404) return { exists: false, anonymous: false }
      if (!res.ok) return null
      const body = (await res.json()) as { exists?: boolean; anonymous?: boolean }
      if (typeof body.exists !== "boolean") return null
      return { exists: body.exists, anonymous: !!body.anonymous }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function signOut(): Promise<void> {
    if (!stored) return
    try {
      await fetch(`${cfg.baseUrl()}/signout`, {
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
        return await fetch(`${cfg.baseUrl()}/account/delete`, {
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

    let res = await doDelete(stored.accessToken)
    if (res.status === 401) {
      // Stale access token — try one refresh + retry. getAccessToken()
      // handles the refresh-coalesce and clears tokens on refresh
      // failure, so a null return means the session is already gone.
      const refreshed = await getAccessToken()
      if (!refreshed) throw new AccountDeleteError("unauthorized", 401)
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
    if (!stored) return null
    // Coalesce with the lazy-refresh path so a foreground sync that
    // races a getAccessToken() doesn't fire /auth/refresh twice.
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const tr = await callRefresh(stored!.refreshToken)
          if (!tr) {
            await clearTokens()
            return null
          }
          await commitTokenResponse(tr)
          return stored!.accessToken
        } finally {
          refreshInFlight = null
        }
      })()
    }
    const tok = await refreshInFlight
    if (!tok) return null
    return session
  }

  async function migrateToRegion(newRegionId: string): Promise<MigrationResult> {
    // Need a fresh access token to present to the destination region's
    // `/auth/migrate-in` — that token's signature (kid + sub claim) is
    // the only proof the destination has that the caller owns the
    // source-side identity.
    const access = await getAccessToken()
    if (!access) {
      return { ok: false, code: "no_session", message: "no active session" }
    }

    // Adapter doesn't reach into `shruti.servers` — the route is
    // passed in via cfg.resolveAuthBaseUrl(newRegionId). Unknown region
    // → throw → map to "rejected" so the UI shows a sensible toast
    // instead of a confusing "network error".
    let destAuthBaseUrl: string
    try {
      destAuthBaseUrl = cfg.resolveAuthBaseUrl(newRegionId)
    } catch {
      return { ok: false, code: "rejected", message: `unknown region: ${newRegionId}` }
    }

    const sourceRegionId = cfg.currentRegionId()
    let res: Response
    try {
      res = await fetch(`${destAuthBaseUrl}/migrate-in`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/json",
        },
        // Empty body — deviceId/anything else the server cares about
        // is read from the bearer's claims.
        body: JSON.stringify({}),
      })
    } catch (err) {
      return {
        ok: false,
        code: "network",
        message: err instanceof Error ? err.message : "network error",
      }
    }

    if (!res.ok) {
      if (res.status === 400) {
        // Anonymous-only identities (device-subject only) or other
        // bad-shape rejections. Anonymous switch uses signOut+reboot,
        // not migration — see SettingsAccountGroup tap handler.
        return { ok: false, code: "rejected", message: `status ${res.status}` }
      }
      return { ok: false, code: "unreachable", message: `status ${res.status}` }
    }

    const body = (await res.json()) as TokenResponseBody
    // commitTokenResponse() persists, decodes claims and fires the
    // session-change listener — which propagates the new userId
    // through useAuthStore so the existing watcher in
    // usePurchasesStore.init() picks it up and re-links RC.
    await commitTokenResponse(body)

    // Composition root flips `activeServer` + enqueues source-side
    // revoke + tries to drain it once while we still have network.
    cfg.onMigrationCompleted?.(newRegionId, sourceRegionId, access)

    return { ok: true, newUserId: body.userId }
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
    completeSigninAfterRetry,
    lookupAccount,
    signOut,
    deleteAccount,
    migrateToRegion,
    getSession,
    getAccessToken,
    refreshTokens,
    fetchMe,
    onSessionChange,
  }
}
