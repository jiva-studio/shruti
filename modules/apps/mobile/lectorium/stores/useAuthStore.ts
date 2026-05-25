import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { App, type AppState } from "@capacitor/app"
import { useLectorium } from "@lectorium/lectorium.js"
import { wipeLocalUserData } from "@lectorium/services/dataWipe.js"
import type { AuthSession, AuthStatus } from "@ports/app/auth.js"

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
  const tier = ref<string>("free")

  const signedIn = computed(() => !!userId.value && !anonymous.value)
  const isPro = computed(() => tier.value === "pro")

  let resumeHandle: { remove(): Promise<void> } | undefined

  function applySession(s: AuthSession | null): void {
    if (s) {
      userId.value = s.userId
      email.value = s.email
      name.value = s.name
      picture.value = s.picture
      anonymous.value = s.anonymous
      tier.value = s.tier || "free"
      status.value = s.anonymous ? "anonymous" : "signedIn"
    } else {
      userId.value = null
      email.value = null
      name.value = null
      picture.value = null
      anonymous.value = true
      tier.value = "free"
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
      if (me.tier !== tier.value) {
        await auth.refreshTokens()
      }
    } catch (e) {
      // Silent: this is a best-effort sync, not blocking. Failed
      // requests just leave the cached tier in place until next
      // natural rotation.
      console.warn("[auth] resume tier sync failed", e)
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
      return true
    } catch (e) {
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
      return true
    } catch (e) {
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
   * Delete the server-side account, then optionally wipe local user
   * data. Order matters: if the server call fails (network, 5xx) we
   * MUST NOT touch local data — otherwise the user loses their
   * notes/chats/downloads while still being signed in. On success we
   * drop to anonymous via a fresh bootstrap, same as signOut.
   */
  async function deleteAccount(opts: { wipeLocal: boolean }): Promise<void> {
    const app = useLectorium()
    await app.auth.deleteAccount()
    if (opts.wipeLocal) {
      await wipeLocalUserData(app)
    }
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
    isPro,
    signedIn,
    restore,
    signInGoogle,
    signInApple,
    signOut,
    deleteAccount,
    refreshTokens,
  }
})
