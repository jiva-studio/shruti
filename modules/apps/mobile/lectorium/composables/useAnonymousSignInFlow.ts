import { ref, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { actionSheetController, alertController } from "@ionic/vue"
import { SERVERS } from "@lib/domain/servers.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAuthStore } from "@lectorium/stores/useAuthStore.js"
import { useOverlaysStore } from "@lectorium/stores/useOverlaysStore.js"
import { SigninAccountNotFoundError } from "@ports/app/auth.js"

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
    } catch (e) {
      if (e instanceof SigninAccountNotFoundError) {
        await handleAccountNotFound(e)
      } else {
        throw e
      }
    } finally {
      busy.value = false
    }
  }

  async function runApple(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      await auth.signInApple()
    } catch (e) {
      if (e instanceof SigninAccountNotFoundError) {
        await handleAccountNotFound(e)
      } else {
        throw e
      }
    } finally {
      busy.value = false
    }
  }

  /**
   * Resolve the "other" region's display name. At N=2 regions (global +
   * russia) this is trivial — the one that isn't currently active. If
   * the SERVERS list ever expands beyond two entries the dialog becomes
   * ambiguous and we'd need an explicit picker; until then return the
   * first non-current entry.
   */
  function otherRegion(): { id: string; name: string } | null {
    const currentId = app.activeServer.value.id
    const other = SERVERS.find((s) => s.id !== currentId)
    return other ? { id: other.id, name: other.name } : null
  }

  /**
   * Retry-other-region dialog. The orchestrator already has the verified
   * OAuth idToken (captured in `SigninAccountNotFoundError`), so the
   * user doesn't re-tap the SocialLogin popup along any branch.
   *
   * Branches:
   *  - "Switch to {other}" → flip activeServer to the other region and
   *    retry the same OAuth idToken through completeSigninAfterRetry.
   *  - "Create new here"   → probe the OTHER region for the same
   *    identity; only proceed if {exists: false}. Show a hard-block
   *    dialog on existing account in other region, and a soft-warning
   *    dialog when the probe couldn't resolve (timeout / network).
   *  - Cancel              → no-op.
   */
  async function handleAccountNotFound(err: SigninAccountNotFoundError): Promise<void> {
    const other = otherRegion()
    if (!other) {
      // No other region configured — degrade to "Create new here" path
      // straight away (no dup risk at N=1).
      await proceedCreateHere(err)
      return
    }
    const current = { id: app.activeServer.value.id, name: app.activeServer.value.name }
    const alert = await alertController.create({
      header: t("settings.account.signinRetryOtherRegion.title", { currentRegion: current.name }),
      message: t("settings.account.signinRetryOtherRegion.message", {
        currentRegion: current.name,
        otherRegion: other.name,
      }),
      backdropDismiss: false,
      buttons: [
        {
          text: t("settings.account.signinRetryOtherRegion.switchTo", {
            otherRegion: other.name,
          }),
          handler: () => {
            void switchAndRetry(err, other.id)
          },
        },
        {
          text: t("settings.account.signinRetryOtherRegion.createNew", {
            currentRegion: current.name,
          }),
          handler: () => {
            void createNewHereWithGuard(err, other)
          },
        },
        { text: t("app.cancel"), role: "cancel" },
      ],
    })
    overlays.actionSheetOpen = true
    void alert.onDidDismiss().then(() => {
      overlays.actionSheetOpen = false
    })
    await alert.present()
  }

  async function switchAndRetry(
    err: SigninAccountNotFoundError,
    targetRegionId: string
  ): Promise<void> {
    // The idToken issued by the OAuth provider is for the (app's) audience
    // — both regions verify against the same client IDs, so reusing it
    // against the new region is sound. completeSigninAfterRetry skips
    // the X-Lookup-Only probe; a 404 here would be genuinely surprising
    // (we just confirmed the account didn't live in the OTHER place).
    app.setActiveServerById(targetRegionId)
    busy.value = true
    try {
      await auth.completeSigninAfterRetry(err.provider, err.idToken, err.fullName)
    } finally {
      busy.value = false
    }
  }

  async function createNewHereWithGuard(
    err: SigninAccountNotFoundError,
    other: { id: string; name: string }
  ): Promise<void> {
    busy.value = true
    try {
      const probe = await auth.lookupAccount(other.id, err.provider, err.idToken)
      if (probe === null) {
        // Couldn't verify — surface the dup-account risk warning and
        // give the user the final say.
        const warned = await confirmDupRiskAndProceed(other)
        if (!warned) return
        await proceedCreateHere(err)
        return
      }
      if (probe.exists) {
        await showAlreadyExistsBlock(other, err)
        return
      }
      await proceedCreateHere(err)
    } finally {
      busy.value = false
    }
  }

  async function proceedCreateHere(err: SigninAccountNotFoundError): Promise<void> {
    await auth.completeSigninAfterRetry(err.provider, err.idToken, err.fullName)
  }

  function confirmDupRiskAndProceed(other: { name: string }): Promise<boolean> {
    const current = app.activeServer.value.name
    return new Promise<boolean>((resolve) => {
      void alertController
        .create({
          header: t("settings.account.signinRetryOtherRegion.dupRiskTitle"),
          message: t("settings.account.signinRetryOtherRegion.dupRiskMessage", {
            otherRegion: other.name,
            currentRegion: current,
          }),
          backdropDismiss: false,
          buttons: [
            {
              text: t("settings.account.signinRetryOtherRegion.continueAnyway"),
              handler: () => resolve(true),
            },
            {
              text: t("settings.account.signinRetryOtherRegion.cancel"),
              role: "cancel",
              handler: () => resolve(false),
            },
          ],
        })
        .then((alert) => alert.present())
    })
  }

  async function showAlreadyExistsBlock(
    other: { id: string; name: string },
    err: SigninAccountNotFoundError
  ): Promise<void> {
    const alert = await alertController.create({
      header: t("settings.account.signinRetryOtherRegion.alreadyExistsTitle", {
        otherRegion: other.name,
      }),
      message: t("settings.account.signinRetryOtherRegion.alreadyExistsMessage", {
        otherRegion: other.name,
      }),
      backdropDismiss: false,
      buttons: [
        {
          text: t("settings.account.signinRetryOtherRegion.switchAndRetry"),
          handler: () => {
            void switchAndRetry(err, other.id)
          },
        },
        { text: t("app.cancel"), role: "cancel" },
      ],
    })
    await alert.present()
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
