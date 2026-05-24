import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { useShruti } from "@shruti/shruti.js"
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

  const signedIn = computed(() => !!userId.value && !anonymous.value)

  function applySession(s: AuthSession | null): void {
    if (s) {
      userId.value = s.userId
      email.value = s.email
      name.value = s.name
      picture.value = s.picture
      anonymous.value = s.anonymous
      status.value = s.anonymous ? "anonymous" : "signedIn"
    } else {
      userId.value = null
      email.value = null
      name.value = null
      picture.value = null
      anonymous.value = true
      status.value = "uninitialized"
    }
  }

  async function restore(): Promise<void> {
    const auth = useShruti().auth
    status.value = "restoring"
    try {
      const session = await auth.initialize()
      applySession(session)
      auth.onSessionChange(applySession)
    } catch (e) {
      console.error("[auth] restore failed:", e)
      status.value = "error"
    }
  }

  async function signInGoogle(): Promise<boolean> {
    const auth = useShruti().auth
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
    const auth = useShruti().auth
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
    const auth = useShruti().auth
    await auth.signOut()
    applySession(null)
    // After sign-out we drop to anonymous via a fresh bootstrap so the
    // user can keep using the app (same UX as Spotify free).
    await restore()
  }

  async function deleteAccount(): Promise<void> {
    const auth = useShruti().auth
    await auth.deleteAccount()
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
    signedIn,
    restore,
    signInGoogle,
    signInApple,
    signOut,
    deleteAccount,
  }
})
