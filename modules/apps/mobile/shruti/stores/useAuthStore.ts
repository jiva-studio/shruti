import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"
import { App, type AppState } from "@capacitor/app"
import { useShruti } from "@shruti/shruti.js"
import { useSyncChatsEnabled } from "@shruti/composables/useSyncChats.js"
import { setMonitoringUser, setMonitoringTag } from "@shruti/services/monitoring/index.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import { watchComposeLockReleases } from "@shruti/stores/auth/composeLockWatchers.js"
import { pushPendingOutbox, releaseDevice } from "@shruti/stores/auth/deviceHandover.js"
import { readSessionFields } from "@shruti/stores/auth/sessionFields.js"
import { createSignInFlows } from "@shruti/stores/auth/signInFlows.js"
import { createTierSync } from "@shruti/stores/auth/tierSync.js"
import { AccountDeleteError } from "@ports/app/auth.js"
import type { AuthSession, AuthStatus } from "@ports/app/auth.js"

/** What a sign-out did to this device, so the caller can describe it truthfully. */
export interface SignOutOutcome {
  /** `false` for an unclaimed anonymous session, whose rows stay because nothing could restore them. */
  readonly wiped: boolean
  /** Whether the account holds a copy of the conversations the wipe deleted. Read before the wipe. */
  readonly chatSynced: boolean
  /** Whether the farewell push left journal rows the wipe then destroyed. */
  readonly stranded: boolean
}

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
  /** Raw server tier; read `tier` from the UI instead. */
  const rawTier = ref<string>("free")
  /** UNIX-epoch (ms) at which Pro expires; null for lifetime or free. */
  const tierExpiresAt = ref<number | null>(null)
  /** Server-side quota bucket mirrored from the JWT `quota_id`; "" on tokens that predate it. */
  const quotaId = ref<string>("")

  // The server already coerces a lapsed "pro" back to "free" by server time
  // before it reaches us. We deliberately do NOT re-coerce by the device
  // clock: a fast clock would paywall a user whose entitlement is live.
  const tier = computed<string>(() => rawTier.value || "free")

  const signedIn = computed(() => !!userId.value && !anonymous.value)
  const isPro = computed(() => tier.value === "pro")

  const tierSync = createTierSync({
    port: () => useShruti().auth,
    cached: () => ({ tier: rawTier.value, tierExpiresAt: tierExpiresAt.value }),
  })

  const signIn = createSignInFlows({
    port: () => useShruti().auth,
    applySession: (s) => applySession(s),
    setStatus: (s) => {
      status.value = s
    },
    onSignedIn: tierSync.invalidateAndSync,
  })

  let resumeHandle: { remove(): Promise<void> } | undefined
  // restore() runs again after every signOut/deleteAccount; keep the previous
  // subscription so we can drop it before re-subscribing, otherwise
  // applySession fires N+1 times after N sign-outs.
  let sessionUnsub: (() => void) | undefined

  // `useChatStore` imports this store back; a static cycle between two setup
  // stores is safe as long as neither calls the other at module-eval time.
  function releaseChatComposeLock(): void {
    useChatStore().resetComposeLock()
  }

  watchComposeLockReleases({
    userId,
    isPro,
    quotaId,
    signedIn,
    // Group Sentry errors by account — opaque id only, never name/email/IP.
    onIdentityChange: (id) => setMonitoringUser(id),
    release: releaseChatComposeLock,
  })

  // Lets Sentry issues be filtered by tier. Non-PII.
  watch(isPro, (pro) => setMonitoringTag("tier", pro ? "pro" : "free"), { immediate: true })

  function applySession(s: AuthSession | null): void {
    const next = readSessionFields(s)
    userId.value = next.userId
    email.value = next.email
    name.value = next.name
    picture.value = next.picture
    anonymous.value = next.anonymous
    rawTier.value = next.rawTier
    tierExpiresAt.value = next.tierExpiresAt
    quotaId.value = next.quotaId
    status.value = next.status
  }

  async function restore(): Promise<void> {
    const auth = useShruti().auth
    status.value = "restoring"
    // Both registrations happen BEFORE the awaited bootstrap and neither
    // depends on it succeeding: a first launch offline makes initialize()
    // throw, and subscribing afterwards left the store detached from the port
    // for the whole run.
    sessionUnsub?.()
    sessionUnsub = auth.onSessionChange(applySession)
    if (!resumeHandle) {
      try {
        resumeHandle = await App.addListener("appStateChange", (state: AppState) => {
          if (!state.isActive) return
          void tierSync.syncOnResume()
        })
      } catch (e) {
        console.warn("[auth] appStateChange listener registration failed", e)
      }
    }
    try {
      applySession(await auth.initialize())
    } catch (e) {
      console.error("[auth] restore failed:", e)
      status.value = "error"
    }
  }

  async function refreshTokens(): Promise<void> {
    const auth = useShruti().auth
    try {
      const next = await auth.refreshTokens()
      if (next) applySession(next)
    } catch (e) {
      console.warn("[auth] refreshTokens failed", e)
    }
  }

  /**
   * Sign out and hand the device over clean.
   *
   * The user database is device-wide, so without a wipe the next person to pick
   * up the phone reads the previous account's notes, playlist, history and
   * transcripts. The wipe is silent: the data lives in the account and comes
   * back on the next sign-in, and a dialog on a handed-over phone is answered
   * by the wrong person. The caller tells the user where their data went.
   *
   * `signedIn` is the test — an unclaimed anonymous identity has no server-side
   * copy to restore from, so wiping there would be pure deletion.
   */
  async function signOut(): Promise<SignOutOutcome> {
    const app = useShruti()
    const wipe = signedIn.value
    const ownerId = userId.value
    // Read BEFORE the wipe: with "Sync chats" off nothing was ever journaled,
    // so clearing chat below destroys the only copy there is.
    const chatSynced = useSyncChatsEnabled().value
    const stranded =
      wipe && ownerId ? await pushPendingOutbox(app, ownerId, () => userId.value) : false
    await app.auth.signOut()
    // The previous account's in-flight turns cannot be resumed under the next
    // token — re-polling one 404s and keeps re-arming a notification for 24h.
    await useChatStore().clearPendingTurns()
    // The public catalog stays: byte-identical for every user, and dropping it
    // would only bill the next person a ~54 MB re-download.
    await releaseDevice(app, {
      wipeLocal: wipe,
      wipe: { contentCatalog: "keep" },
      context: "signOut",
    })
    applySession(null)
    // Drop to anonymous via a fresh bootstrap so the user can keep using the app.
    await restore()
    return { wiped: wipe, chatSynced, stranded }
  }

  /**
   * Delete the server-side account, then optionally wipe local user data.
   *
   * Order matters: a network/5xx failure from the server call must not mutate
   * local state, or the user loses their data while the account still exists.
   * Once the server confirms, every cleanup step runs independently, and
   * applySession(null) + restore() run unconditionally at the end.
   */
  async function deleteAccount(opts: { wipeLocal: boolean }): Promise<void> {
    const app = useShruti()
    try {
      await app.auth.deleteAccount()
    } catch (err) {
      if (!(err instanceof AccountDeleteError && err.kind === "already-deleted")) throw err
    }
    await releaseDevice(app, { wipeLocal: opts.wipeLocal, context: "deleteAccount" })
    applySession(null)
    await restore()
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
    isPro,
    signedIn,
    restore,
    signInGoogle: signIn.signInGoogle,
    signInApple: signIn.signInApple,
    requestEmailCode: signIn.requestEmailCode,
    signInEmail: signIn.signInEmail,
    signOut,
    deleteAccount,
    refreshTokens,
    invalidateAndSyncTier: tierSync.invalidateAndSync,
    ensureFresh: tierSync.ensureFresh,
  }
})
