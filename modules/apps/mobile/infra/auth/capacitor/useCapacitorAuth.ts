import { Capacitor } from "@capacitor/core"
import { Device } from "@capacitor/device"
import { Preferences } from "@capacitor/preferences"
import { SocialLogin } from "@capgo/capacitor-social-login"

import type { AuthConfig, AuthPort, AuthSession, MeView } from "@ports/app/auth.js"

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

  function decodeAccessClaims(accessToken: string): { expMs: number; tier: string } {
    try {
      const [, payloadB64] = accessToken.split(".")
      const json = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")))
      return {
        expMs: typeof json.exp === "number" ? json.exp * 1000 : 0,
        tier: typeof json.tier === "string" ? json.tier : "free",
      }
    } catch {
      return { expMs: 0, tier: "free" }
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
    }
  }

  async function fetchMeBody(accessToken: string): Promise<MeBody | null> {
    try {
      const res = await fetch(`${cfg.baseUrl}/me`, {
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
    const res = await fetch(`${cfg.baseUrl}/anonymous`, {
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
    const res = await fetch(`${cfg.baseUrl}/refresh`, {
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
    const res = await fetch(`${cfg.baseUrl}/signin/${provider}`, {
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
    const idToken = result.result?.accessToken?.token
    if (!idToken) return null
    const { givenName, familyName } = result.result.profile ?? {}
    const fullName = [givenName, familyName].filter(Boolean).join(" ").trim() || undefined
    const tokens = await callSignin("apple", idToken, fullName)
    return commitTokenResponse(tokens)
  }

  async function signOut(): Promise<void> {
    if (!stored) return
    try {
      await fetch(`${cfg.baseUrl}/signout`, {
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
    await fetch(`${cfg.baseUrl}/account/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${stored.accessToken}`,
      },
    })
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
    signOut,
    deleteAccount,
    getSession,
    getAccessToken,
    refreshTokens,
    fetchMe,
    onSessionChange,
  }
}
