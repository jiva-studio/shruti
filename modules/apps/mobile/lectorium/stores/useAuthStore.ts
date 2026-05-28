import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"
import { App, type AppState } from "@capacitor/app"
import { SERVERS } from "@lib/domain/servers.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { wipeLocalUserData } from "@lectorium/services/dataWipe.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import { AccountDeleteError } from "@infra/auth/capacitor/useCapacitorAuth.js"
import type { AuthSession, AuthStatus, MigrationResult } from "@ports/app/auth.js"
import { SigninAccountNotFoundError } from "@ports/app/auth.js"

/**
 * Reactive view over the AuthPort. Mirrors the port's session into Pinia
 * so Vue components can pick it up declaratively. The port is still the
 * source of truth — all writes go through it.
 */
export const useAuthStore = defineStore("auth", () => {
  const status = ref<AuthStatus>("uninitialized")
  const userId = ref<string | null>(null)
  const email = ref<string | null>(null)
  const name = ref<string | null>(null)
  const picture = ref<string | null>(null)
  const anonymous = ref<boolean>(true)
  // Raw server tier. Don't read this directly from UI — use `tier`
  // which applies the tier_expires_at coercion. Stored separately so a
  // future webhook flip can land back to "pro" without losing the raw
  // value just because the cached expiry happened to be in the past.
  const rawTier = ref<string>("free")
  // UNIX-epoch (ms) at which the Pro entitlement expires. null = lifetime
  // or free (no expiry concept). Mirrored from /auth/me's tierExpiresAt
  // (ISO string parsed to ms). Drives the `tier` getter's coercion.
  const tierExpiresAt = ref<number | null>(null)
  // Server-side quota bucket id mirrored from the JWT `quota_id` claim.
  // Stable per-identity (PR-1 made anon device-bootstrap users non-empty
  // too). A change under the same `userId` means token rotation (the
  // claim carried a refreshed bucket id) — see the `quotaId` watcher
  // below for why that resets the chat lockout. Empty string on
  // pre-PR-1 tokens still in flight; consumers must treat "" as "no
  // quota_id yet".
  const quotaId = ref<string>("")
  // Server-authoritative region (auth.users.home_region). Empty string
  // until the first /auth/me lands; consumers should treat "" as "no
  // server truth yet" and avoid asserting region drift on it.
  const homeRegion = ref<string>("")

  // Public tier. Coerces a "pro" with a past expiry back to "free" so a
  // stale auth-cached value (dropped EXPIRATION webhook) can't keep the
  // UI on Pro past the real boundary. Lifetime Pro (expiry null) is
  // never coerced.
  const tier = computed<string>(() => {
    if (rawTier.value !== "pro") return rawTier.value || "free"
    if (tierExpiresAt.value === null) return "pro" // lifetime
    if (tierExpiresAt.value < Date.now()) return "free"
    return "pro"
  })

  const signedIn = computed(() => !!userId.value && !anonymous.value)
  const isPro = computed(() => tier.value === "pro")

  let resumeHandle: { remove(): Promise<void> } | undefined
  /**
   * Wall-clock at the last successful `/auth/me` round-trip. Used by
   * `ensureFresh()` to cheaply skip the request when we already pulled
   * a fresh tier within the last 5 minutes — the foreground-resume
   * watcher pushes this forward on every resume, so the chat composer
   * doesn't redundantly fetch /auth/me on every send.
   */
  let lastSyncAt = 0
  const ENSURE_FRESH_MAX_AGE_MS = 5 * 60 * 1000

  // Identity-change watcher: signin (null→id), signout (id→null), and
  // switch-account (idA→idB) all invalidate any composer lockdown the
  // chat store may be holding — the deadline was bound to the previous
  // identity's quota bucket and means nothing for the new one.
  //
  // `useChatStore` is imported lazily here so this module doesn't pull
  // the chat store graph at auth-store registration time, which would
  // race Pinia's init order (chat store depends on `useLectorium()`
  // wiring that lands after auth restore kicks off).
  watch(userId, (newId, oldId) => {
    if (newId === oldId) return
    void import("@lectorium/stores/useChatStore.js").then(({ useChatStore }) => {
      useChatStore().resetComposeLock()
    })
  })

  // Tier-upgrade watcher: free → pro within the same user_id (in-place
  // IAP, or webhook landing for a purchase made on another device)
  // makes a stale free-tier `composeBlockedUntil` deadline moot — Pro's
  // quota policy is different and the user shouldn't have to wait out
  // the previous tier's lockout. We only trigger on the upgrade edge
  // (true after false); pro → free expiry doesn't need to clear locks
  // (if anything, the new tier deserves its own rate-limit bookkeeping).
  watch(isPro, (next, prev) => {
    if (!next || prev) return
    void import("@lectorium/stores/useChatStore.js").then(({ useChatStore }) => {
      useChatStore().resetComposeLock()
    })
  })

  // Quota-bucket watcher: when the JWT rotates under the same userId
  // and carries a different `quota_id`, the previous bucket's deadline
  // is meaningless against the new bucket — releasing it lets a Pro
  // user whose stale-claim 429 armed a free-tier lockout recover as
  // soon as the next token refresh lands (~15 min), instead of waiting
  // out the full free-tier deadline. The userId-change watcher above
  // wouldn't fire here (same identity). Empty-string transitions (
  // initial restore from "" to a real id, or rare signout-side flush)
  // are skipped because there was no live lockout to release.
  watch(quotaId, (next, prev) => {
    if (next === prev) return
    if (!prev || !next) return
    void import("@lectorium/stores/useChatStore.js").then(({ useChatStore }) => {
      useChatStore().resetComposeLock()
    })
  })

  function applySession(s: AuthSession | null): void {
    if (s) {
      userId.value = s.userId
      email.value = s.email
      name.value = s.name
      picture.value = s.picture
      anonymous.value = s.anonymous
      rawTier.value = s.tier || "free"
      tierExpiresAt.value = s.tierExpiresAt ?? null
      quotaId.value = s.quotaId ?? ""
      homeRegion.value = s.homeRegion ?? ""
      status.value = s.anonymous ? "anonymous" : "signedIn"
    } else {
      userId.value = null
      email.value = null
      name.value = null
      picture.value = null
      anonymous.value = true
      rawTier.value = "free"
      tierExpiresAt.value = null
      quotaId.value = ""
      homeRegion.value = ""
      status.value = "uninitialized"
    }
  }

  async function restore(): Promise<void> {
    const auth = useLectorium().auth
    status.value = "restoring"
    try {
      const session = await auth.initialize()
      applySession(session)
      auth.onSessionChange(applySession)
      // Foreground-resume tier sync. Webhook-driven tier flips (purchase
      // on another device, subscription expired, refund) reach the server
      // immediately but the running JWT carries the stale value until
      // natural rotation (~15 min). On resume, ask /auth/me for the
      // canonical tier; if it diverges, force a refresh now.
      if (!resumeHandle) {
        resumeHandle = await App.addListener("appStateChange", (state: AppState) => {
          if (!state.isActive) return
          void syncTierOnResume()
        })
      }
    } catch (e) {
      console.error("[auth] restore failed:", e)
      status.value = "error"
    }
  }

  async function syncTierOnResume(): Promise<void> {
    const auth = useLectorium().auth
    try {
      const me = await auth.fetchMe()
      if (!me) return
      lastSyncAt = Date.now()
      // Compare against the raw server tier — `tier.value` is the
      // already-coerced view. If the server's view diverges (webhook
      // flipped to Pro, or expiry shifted) force a refresh so the JWT
      // claim catches up.
      const rawDiverged = me.tier !== rawTier.value
      const expiryDiverged = (me.tierExpiresAt ?? null) !== tierExpiresAt.value
      if (rawDiverged || expiryDiverged) {
        await auth.refreshTokens()
      }
    } catch (e) {
      // Silent: this is a best-effort sync, not blocking. Failed
      // requests just leave the cached tier in place until next
      // natural rotation.
      console.warn("[auth] resume tier sync failed", e)
    }
  }

  /**
   * Ensure the cached session is "recent enough" before a tier-sensitive
   * action (chat send, paywall open, etc). Cheap no-op when we synced
   * within the last 5 min; otherwise probes `/auth/me` once and forces
   * a token refresh when the server tier diverges from the cached JWT
   * claim.
   *
   * Race we're closing: app backgrounded 1h → resume → user taps Send
   * in the same frame as the resume listener fires. Without this guard
   * the send goes out under a stale JWT (free) even though the server
   * already knows the user is Pro (webhook landed while the app was
   * suspended).
   *
   * Never throws. On timeout / network error we log and let the caller
   * proceed — sending under the stale tier is preferable to blocking
   * the UI on a dead network.
   */
  async function ensureFresh({ timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<void> {
    if (Date.now() - lastSyncAt < ENSURE_FRESH_MAX_AGE_MS) return
    const auth = useLectorium().auth
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    })
    try {
      const result = await Promise.race([auth.fetchMe(), timeout])
      if (result === "timeout") {
        console.warn("[auth] ensureFresh timed out", { timeoutMs })
        return
      }
      if (!result) return
      lastSyncAt = Date.now()
      if (result.tier !== tier.value) {
        await auth.refreshTokens()
      }
    } catch (e) {
      console.warn("[auth] ensureFresh failed", e)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function refreshTokens(): Promise<void> {
    const auth = useLectorium().auth
    try {
      const next = await auth.refreshTokens()
      if (next) applySession(next)
    } catch (e) {
      console.warn("[auth] refreshTokens failed", e)
    }
  }

  /**
   * Post-signin tier sync. The session we just got back may still
   * carry a pre-purchase tier claim — the RC webhook can land seconds
   * AFTER the SSO provider returns, so the freshly-minted JWT may say
   * "free" while the server already knows the user is Pro (purchase
   * made earlier under another device, or another anon user upgraded).
   * Without this, the user's next chat send goes out under the stale
   * claim → server 429s with tier=free even though the subscription is
   * active, and the only way out is an app restart that re-bootstraps
   * `/auth/me`.
   *
   * A single `ensureFresh()` call here is not enough: it'd set
   * `lastSyncAt` to NOW even if /auth/me still returned "free", and
   * the chat composer's own `ensureFresh()` would then short-circuit
   * for 5 min — straight through the window when the webhook usually
   * lands. We loop the probe a few times with a short backoff so the
   * webhook gets a chance to catch up before we freeze the cache.
   * Fire-and-forget; never throws.
   */
  function invalidateAndSyncAfterSignin(): void {
    lastSyncAt = 0
    void syncTierAfterSignin()
  }

  /**
   * Bounded retry loop for the post-signin tier sync. Probes /auth/me
   * up to `ATTEMPTS` times, refreshing tokens the first time the
   * server's tier (or expiry) diverges from the cached JWT view. Exits
   * early once we observe non-free or detect a flip. `lastSyncAt` is
   * only stamped at exit, so the chat composer's `ensureFresh()`
   * stays armed (i.e. won't short-circuit) for the duration of the
   * retry window — if the user taps Send during that window, the
   * composer's own probe coalesces with the webhook landing path.
   */
  async function syncTierAfterSignin(): Promise<void> {
    const ATTEMPTS = 5
    const DELAY_MS = 3000
    const auth = useLectorium().auth
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        const me = await auth.fetchMe()
        if (!me) {
          lastSyncAt = Date.now()
          return
        }
        const rawDiverged = me.tier !== rawTier.value
        const expiryDiverged = (me.tierExpiresAt ?? null) !== tierExpiresAt.value
        if (rawDiverged || expiryDiverged) {
          await auth.refreshTokens()
          lastSyncAt = Date.now()
          return
        }
        if (me.tier !== "free") {
          lastSyncAt = Date.now()
          return
        }
      } catch (e) {
        console.warn("[auth] post-signin tier sync attempt failed", e)
      }
      if (i < ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, DELAY_MS))
      }
    }
    lastSyncAt = Date.now()
  }

  async function signInGoogle(): Promise<boolean> {
    const auth = useLectorium().auth
    status.value = "signingIn"
    try {
      const session = await auth.signInWithGoogle()
      if (!session) {
        // User canceled — fall back to whatever we had.
        applySession(auth.getSession())
        return false
      }
      applySession(session)
      invalidateAndSyncAfterSignin()
      return true
    } catch (e) {
      // SigninAccountNotFoundError is the retry-other-region trigger.
      // Re-throw so the orchestrator (useAnonymousSignInFlow) can
      // present the dialog instead of treating it as a generic error.
      if (e instanceof SigninAccountNotFoundError) {
        // Reset status so the busy spinner clears; the dialog will
        // drive its own UX from here.
        applySession(auth.getSession())
        throw e
      }
      console.error("[auth] google sign-in failed:", e)
      status.value = "error"
      return false
    }
  }

  async function signInApple(): Promise<boolean> {
    const auth = useLectorium().auth
    status.value = "signingIn"
    try {
      const session = await auth.signInWithApple()
      if (!session) {
        applySession(auth.getSession())
        return false
      }
      applySession(session)
      invalidateAndSyncAfterSignin()
      return true
    } catch (e) {
      if (e instanceof SigninAccountNotFoundError) {
        applySession(auth.getSession())
        throw e
      }
      console.error("[auth] apple sign-in failed:", e)
      status.value = "error"
      return false
    }
  }

  async function signOut(): Promise<void> {
    const auth = useLectorium().auth
    await auth.signOut()
    applySession(null)
    // After sign-out we drop to anonymous via a fresh bootstrap so the
    // user can keep using the app (same UX as Spotify free).
    await restore()
  }

  /**
   * Anonymous-only region switch. Tears the current device-bootstrap user
   * down on the source region, flips `activeServer` to the destination,
   * then mints a fresh anonymous user there.
   *
   * Order matters: the naive "store.signOut() then setActiveServerById"
   * sequence mints the new anonymous JWT against the SOURCE region's
   * `/auth/anonymous` (because `signOut` triggers `restore()` while
   * `cfg.baseUrl()` still points at the source) — its `kid` then fails
   * verification on the destination's chat backend, requiring an app
   * restart to recover. Doing the region flip BEFORE the implicit
   * re-bootstrap closes that race. The `activeServer` watcher inside
   * `initLectorium` handles persisting `preferredServerId` so a cold
   * start lands on the destination.
   *
   * Signed-in users must NOT call this — server's `/auth/anonymous`
   * doesn't carry over their identity; use `migrateToRegion` instead.
   */
  async function switchAnonymousRegion(newRegionId: string): Promise<void> {
    const app = useLectorium()
    // Validate up front so a typoed id can't leave us with a half-
    // completed signOut and no destination to bootstrap against.
    if (!SERVERS.some((s) => s.id === newRegionId)) {
      throw new Error(`Unknown server id: ${newRegionId}`)
    }
    // (1) Port-level signOut: clears persisted tokens AND hits the SOURCE
    //     region's /signout. Direct port call (not store.signOut) so the
    //     implicit `restore()` from the store's signOut doesn't fire here.
    await app.auth.signOut()
    applySession(null)
    // (2) Flip activeServer BEFORE the re-bootstrap so cfg.baseUrl()
    //     resolves to the destination region for /auth/anonymous.
    app.setActiveServerById(newRegionId)
    // (3) Re-bootstrap anonymous against the destination region.
    await restore()
  }

  /**
   * Delete the server-side account, then optionally wipe local user
   * data. Order matters: a network/5xx failure from the server call
   * MUST NOT mutate local state, otherwise the user loses their
   * notes/chats/downloads while their server account still exists.
   *
   * Once the server confirms the delete (or reports 410 — already
   * gone, tokens cleared by the adapter), every cleanup step runs
   * independently: wipe failing doesn't block RC logOut, RC logOut
   * failing doesn't block dropping to anonymous. applySession(null) +
   * restore() are the only steps required to reach a clean anonymous
   * UI, so they run unconditionally at the end.
   */
  async function deleteAccount(opts: { wipeLocal: boolean }): Promise<void> {
    const app = useLectorium()
    try {
      await app.auth.deleteAccount()
    } catch (err) {
      if (!(err instanceof AccountDeleteError && err.kind === "already-deleted")) throw err
    }
    if (opts.wipeLocal) {
      try {
        await wipeLocalUserData(app)
      } catch (e) {
        console.warn("[auth] wipe failed during deleteAccount:", e)
      }
    }
    // The usePurchasesStore userId watcher already unbinds RC on the
    // session flip below; this synchronous call is the backstop so the
    // SDK is detached before applySession races the watcher.
    try {
      await usePurchasesStore().logOut()
    } catch (e) {
      console.warn("[auth] RC logOut on delete failed:", e)
    }
    applySession(null)
    await restore()
  }

  /**
   * Move the signed-in account to another region. Thin wrapper over the
   * port — the port persists destination tokens, fires the
   * session-change listener (which updates this store via
   * `applySession`) and triggers `onMigrationCompleted` to switch
   * `activeServer` + queue the source-side revoke. Anonymous users
   * must NOT call this — server rejects with 400; the Settings UI
   * routes anonymous tap to signOut+reboot instead.
   */
  async function migrateToRegion(newRegionId: string): Promise<MigrationResult> {
    const auth = useLectorium().auth
    return auth.migrateToRegion(newRegionId)
  }

  /**
   * Resume a signin flow that was paused by a `SigninAccountNotFoundError`.
   * The orchestrator captured the OAuth idToken at the popup step; this
   * call commits the bootstrap on the CURRENT region (which may now be
   * a region the user switched to via the retry-other-region dialog).
   */
  async function completeSigninAfterRetry(
    provider: "google" | "apple",
    idToken: string,
    fullName?: string
  ): Promise<boolean> {
    const auth = useLectorium().auth
    status.value = "signingIn"
    try {
      const session = await auth.completeSigninAfterRetry(provider, idToken, fullName)
      applySession(session)
      invalidateAndSyncAfterSignin()
      return true
    } catch (e) {
      console.error("[auth] completeSigninAfterRetry failed:", e)
      status.value = "error"
      return false
    }
  }

  /**
   * Probe a DIFFERENT region for an existing account, used by the
   * retry-other-region dialog's dup-prevention guard. Returns null on
   * any uncertainty (timeout / network / non-2xx other than 404) so the
   * caller can surface the dup-account-risk warning.
   */
  async function lookupAccount(
    regionId: string,
    provider: "google" | "apple",
    idToken: string
  ): Promise<{ exists: boolean; anonymous: boolean } | null> {
    const auth = useLectorium().auth
    return auth.lookupAccount(regionId, provider, idToken)
  }

  return {
    status,
    userId,
    email,
    name,
    picture,
    anonymous,
    tier,
    rawTier,
    tierExpiresAt,
    quotaId,
    homeRegion,
    isPro,
    signedIn,
    restore,
    signInGoogle,
    signInApple,
    completeSigninAfterRetry,
    lookupAccount,
    signOut,
    switchAnonymousRegion,
    deleteAccount,
    migrateToRegion,
    refreshTokens,
    ensureFresh,
  }
})
