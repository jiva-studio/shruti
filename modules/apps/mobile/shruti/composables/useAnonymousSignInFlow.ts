import { ref, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { actionSheetController } from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"
import { useAuthStore } from "@shruti/stores/useAuthStore.js"
import { useOverlaysStore } from "@shruti/stores/useOverlaysStore.js"

export interface UseAnonymousSignInFlowReturn {
  /**
   * Kick off the platform-aware sign-in prompt. On iOS this presents an
   * action sheet with Apple + Google; on Android and web it calls the
   * Google handler directly (the only available provider — a one-option
   * sheet would be friction).
   */
  triggerSignIn: () => Promise<void>
  /** True while a sign-in round-trip is in flight. */
  busy: Ref<boolean>
}

/**
 * Shared anonymous sign-in entrypoint. Used by the chat limit banner
 * (`ChatMessageBubble` rate-limited CTA) and the Settings account row
 * (`SettingsAccountGroup`) so both surfaces hit the exact same
 * platform-aware flow without duplicating the branching logic.
 *
 * The composable owns the action-sheet primitive (imperative
 * `actionSheetController`, no template real estate required) and drives
 * the real `useAuthStore` actions — no mocks, no event re-emit.
 */
export function useAnonymousSignInFlow(): UseAnonymousSignInFlowReturn {
  const { t } = useI18n()
  const app = useShruti()
  const auth = useAuthStore()
  const overlays = useOverlaysStore()
  const busy = ref(false)

  async function runGoogle(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      await auth.signInGoogle()
    } finally {
      busy.value = false
    }
  }

  async function runApple(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      await auth.signInApple()
    } finally {
      busy.value = false
    }
  }

  // Email is a non-blocking flow: it opens the global modal (mounted in
  // App.vue) instead of awaiting a single round-trip, so `busy` doesn't
  // apply here — the modal owns its own in-flight state.
  function runEmail(): void {
    overlays.emailSignInOpen = true
  }

  async function presentSheet(): Promise<void> {
    const buttons = [
      // iOS convention: Apple first. Android/web don't offer Apple.
      ...(app.platform === "ios"
        ? [
            {
              text: t("settings.account.signInWithApple"),
              handler: () => {
                void runApple()
              },
            },
          ]
        : []),
      {
        text: t("settings.account.signInWithGoogle"),
        handler: () => {
          void runGoogle()
        },
      },
      {
        text: t("settings.account.signInWithEmail"),
        handler: () => {
          runEmail()
        },
      },
      { text: t("app.cancel"), role: "cancel" },
    ]
    const sheet = await actionSheetController.create({ buttons })
    overlays.actionSheetOpen = true
    void sheet.onDidDismiss().then(() => {
      overlays.actionSheetOpen = false
    })
    await sheet.present()
  }

  async function triggerSignIn(): Promise<void> {
    if (busy.value) return
    // The off-store build has no Google services: email OTP is the only
    // sign-in method, so skip the chooser and open the email modal directly.
    if (__OFFSTORE_BUILD__) {
      runEmail()
      return
    }
    // Otherwise every platform has at least two methods (Google + Email,
    // plus Apple on iOS), so present the chooser sheet.
    await presentSheet()
  }

  return { triggerSignIn, busy }
}
