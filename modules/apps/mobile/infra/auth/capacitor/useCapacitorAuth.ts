import { Capacitor } from "@capacitor/core"
import { Device } from "@capacitor/device"
import { SocialLogin } from "@capgo/capacitor-social-login"

import type {
  AccessTokenOptions,
  AuthConfig,
  AuthPort,
  AuthSession,
  MeView,
} from "@ports/app/auth.js"

import { createDeleteAccount } from "./authAccountDelete.js"
import { callAnonymous, callRefresh, fetchMeBody } from "./authHttp.js"
import { createAuthSessionStore } from "./authSessionStore.js"
import { createSignInFlows } from "./authSignInFlows.js"
import { createSocialInit } from "./socialSignIn.js"

/**
 * Ceiling on how long the memoised refresh may hold the mutex. Comfortably
 * above the transport's own deadline, so a normal timeout still surfaces as a
 * transient failure and this only fires if the request layer failed to settle.
 */
const REFRESH_SETTLE_TIMEOUT_MS = 30_000

const readDeviceId = async (): Promise<string> => (await Device.getId()).identifier

/**
 * Single-adapter implementation of AuthPort. Works on native (Android/iOS) via
 * @capgo/capacitor-social-login; on web the social-login path returns null
 * gracefully — in-browser dev only, there is no Welcome flow outside the app.
 */
export function useCapacitorAuth(cfg: AuthConfig): AuthPort {
  const store = createAuthSessionStore(cfg.request)
  let refreshInFlight: Promise<string | null> | null = null
  // Coalesces concurrent anonymous bootstraps behind one /auth/anonymous
  // round-trip, the same way refreshInFlight does; without it a token-less app
  // could fire N mint calls.
  let bootstrapInFlight: Promise<AuthSession> | null = null

  /**
   * The `Authorization` header the sign-in endpoints carry. It tells the
   * server to UPGRADE this device's user in place instead of minting a
   * stranger, so it has to be a token the server can still verify: read it
   * through `getAccessToken()`, which rotates at `exp - 60s`. Absent a session
   * we send nothing — deliberately not bootstrapping an anonymous identity
   * just to decorate a sign-in.
   */
  async function signinAuthHeader(): Promise<Record<string, string>> {
    if (!store.tokens()) return {}
    const token = await getAccessToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  // The anonymous identity is the app's floor, so any path that finds itself
  // token-less can fall back through here rather than giving up until restart.
  function bootstrapAnonymous(): Promise<AuthSession> {
    if (!bootstrapInFlight) {
      bootstrapInFlight = (async () => {
        try {
          const tokens = await callAnonymous(
            cfg.request,
            { deviceId: await readDeviceId(), platform: Capacitor.getPlatform() },
            store.tokens()?.accessToken ?? null
          )
          return await store.commit(tokens)
        } finally {
          bootstrapInFlight = null
        }
      })()
    }
    return bootstrapInFlight
  }

  /**
   * Call `/auth/refresh` and return the new access token, coalescing
   * concurrent callers behind a single round-trip. The ONLY place tokens are
   * rotated, so the lazy path in `getAccessToken`, the tier-driven
   * `refreshTokens` and the 401 interceptor share one mutex instead of three.
   *
   * Being memoised, this is the one promise in the app whose non-settlement is
   * process-fatal — chat, sync, ingest and discovery all await the same
   * bearer. The transport has its own deadline; the race below is the second
   * lock on that door, and it costs one timer.
   */
  function forceRefresh(): Promise<string | null> {
    const tokens = store.tokens()
    if (!tokens) return Promise.resolve(null)
    if (refreshInFlight) return refreshInFlight

    const run = (async () => {
      const r = await callRefresh(cfg.request, tokens.refreshToken)
      if (!r.ok) {
        // Only a genuine rejection drops the session; a transient failure
        // leaves the tokens intact so the next call retries.
        if (r.rejected) await store.clear()
        return null
      }
      // Return the token from the response, not a re-read of the store — a
      // concurrent clear() could empty it between the await and the read.
      await store.commit(r.body)
      return r.body.accessToken
    })()

    let deadline: ReturnType<typeof setTimeout>
    // Resolving null (not rejecting) reports what a transient failure does —
    // no token this time, session intact, ask again later.
    const guarded: Promise<string | null> = Promise.race([
      run,
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), REFRESH_SETTLE_TIMEOUT_MS)
      }),
    ]).finally(() => {
      clearTimeout(deadline)
      // `run` may settle long after the deadline released the mutex, and must
      // not null out the NEXT refresh.
      if (refreshInFlight === guarded) refreshInFlight = null
    })
    refreshInFlight = guarded
    return guarded
  }

  /**
   * Re-mint the anonymous identity for a caller that finds itself token-less,
   * after a failed boot bootstrap or a refresh rejection. Handing back null
   * forever would leave the app hung until a manual restart — which only
   * retries once.
   */
  async function recoverAnonymously(): Promise<string | null> {
    try {
      await bootstrapAnonymous()
    } catch (e) {
      console.warn("[auth] anonymous bootstrap recovery failed", e)
      return null
    }
    return store.tokens()?.accessToken ?? null
  }

  async function getAccessToken(options?: AccessTokenOptions): Promise<string | null> {
    const tokens = store.tokens()
    if (!tokens) {
      // A caller whose request carries data belonging to a named identity says
      // so and gets null instead: the bootstrap mints a DIFFERENT account, and
      // a sync push resolved through it uploads the batch — and marks it sent
      // — into an id nobody can ever reach again.
      if (options?.allowBootstrap === false) return null
      return recoverAnonymously()
    }
    if (tokens.accessTokenExpiresAt - Date.now() > 60_000) return tokens.accessToken
    return forceRefresh()
  }

  const signIn = createSignInFlows({
    request: cfg.request,
    getLocale: () => cfg.getLocale?.() ?? "",
    ensureSocialInit: createSocialInit(cfg),
    authHeader: signinAuthHeader,
    readDeviceId,
    commit: store.commit,
  })

  const deleteAccount = createDeleteAccount({
    request: cfg.request,
    currentUserId: () => store.tokens()?.userId ?? null,
    currentAccessToken: () => store.tokens()?.accessToken ?? null,
    getAccessToken: () => getAccessToken(),
    clearTokens: store.clear,
  })

  async function initialize(): Promise<AuthSession> {
    return (await store.restore()) ?? (await bootstrapAnonymous())
  }

  async function signOut(): Promise<void> {
    const tokens = store.tokens()
    if (!tokens) return
    try {
      await cfg.request("/signout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokens.accessToken}`,
        },
        body: JSON.stringify({ refreshToken: tokens.refreshToken }),
      })
    } catch {
      // Still drop tokens locally; the server-side refresh becomes orphaned
      // but harmless.
    }
    try {
      await SocialLogin.logout({ provider: "google" }).catch(() => undefined)
      await SocialLogin.logout({ provider: "apple" }).catch(() => undefined)
    } catch {
      /* best-effort */
    }
    await store.clear()
  }

  async function refreshTokens(): Promise<AuthSession | null> {
    // Coalesces with the lazy-refresh path so a foreground sync racing a
    // getAccessToken() doesn't fire /auth/refresh twice.
    const tok = await forceRefresh()
    // The session is the just-committed one unless a concurrent clear() raced
    // in and nulled it, which the caller handles.
    if (!tok) return null
    return store.current()
  }

  async function fetchMe(): Promise<MeView | null> {
    const tok = await getAccessToken()
    if (!tok) return null
    const me = await fetchMeBody(cfg.request, tok)
    if (!me) return null
    return {
      tier: me.tier ?? "free",
      tierExpiresAt: me.tierExpiresAt ? Date.parse(me.tierExpiresAt) : null,
    }
  }

  return {
    initialize,
    signInWithGoogle: signIn.signInWithGoogle,
    signInWithApple: signIn.signInWithApple,
    requestEmailOtp: signIn.requestEmailOtp,
    verifyEmailOtp: signIn.verifyEmailOtp,
    signOut,
    deleteAccount,
    getSession: store.current,
    getAccessToken,
    refreshTokens,
    refreshAccessToken: forceRefresh,
    fetchMe,
    onSessionChange: store.onChange,
  }
}
