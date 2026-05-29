import { ref, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { actionSheetController } from "@ionic/vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { useOverlaysStore } from "@lectorium/stores/useOverlaysStore.js"

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
  const app = useLectorium()
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

  async function presentSheet(): Promise<void> {
    const sheet = await actionSheetController.create({
      buttons: [
        // iOS convention: Apple first.
        {
          text: t("settings.account.signInWithApple"),
          handler: () => {
            void runApple()
          },
        },
        {
          text: t("settings.account.signInWithGoogle"),
          handler: () => {
            void runGoogle()
          },
        },
        { text: t("app.cancel"), role: "cancel" },
      ],
    })
    overlays.actionSheetOpen = true
    void sheet.onDidDismiss().then(() => {
      overlays.actionSheetOpen = false
    })
    await sheet.present()
  }

  async function triggerSignIn(): Promise<void> {
    if (busy.value) return
    // Only iOS offers a real choice. Android and web come down to
    // Google-only — skip the one-option sheet and trigger directly.
    if (app.platform === "ios") {
      await presentSheet()
      return
    }
    await runGoogle()
  }

  return { triggerSignIn, busy }
}
