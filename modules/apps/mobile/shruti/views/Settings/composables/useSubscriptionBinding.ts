import { computed, reactive } from "vue"
import { useI18n } from "vue-i18n"
import { alertController } from "@ionic/vue"
import { useShruti } from "@shruti/shruti.js"
import { privacyPolicyUrl } from "@shruti/i18n/index.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import {
  PurchaseCancelledError,
  PurchaseNotAllowedError,
  type PurchasePackage,
} from "@ports/app/purchases.js"

export interface LegalDocument {
  title: string
  link: string
}

/**
 * Plain (auto-unwrapped) view over the purchases store, suitable for
 * passing into UI components. `reactive` unwraps the nested refs so
 * `binding.available` in a template is `boolean`, not `Ref<boolean>`.
 */
export interface SubscriptionBinding {
  readonly available: boolean
  readonly isSubscribed: boolean
  /**
   * `true` once the purchases store has finished its first
   * `getCustomerState()` round-trip (or has determined the build has no
   * IAP keys). UI that gates on the *answer* to "is this user
   * subscribed?" should wait for `ready` to flip — otherwise it renders
   * the non-subscribed branch during the few seconds RevenueCat takes to
   * respond, then flickers off once the customer info arrives.
   */
  readonly ready: boolean
  /**
   * `true` while an RC.logIn/logOut is in flight. Gate on `ready &&
   * !reconciling` when you need the *final* subscribed answer — an
   * account-tied subscription only surfaces after the post-sign-in logIn
   * round-trip, so `ready` alone still flashes the non-subscribed UI.
   */
  readonly reconciling: boolean
  readonly packages: PurchasePackage[]
  readonly purchasing: boolean
  readonly restoring: boolean
  readonly legalDocuments: LegalDocument[]
  /** RC-side customer id; surfaced in the debug build-info footer. */
  readonly appUserId: string | undefined
  onSubscribe: (packageId: string) => Promise<void>
  onRestore: () => Promise<void>
  onManage: () => void
}

/**
 * Wires the purchases store into the Settings view. The store is the
 * single source of truth — no entitlement state is ever persisted by
 * the app itself. Post-action UX (the thanks alert, restore-not-found
 * alert) lives here rather than inside the UI components so the
 * `ui/features/settings/*` files stay framework-pure.
 */
export function useSubscriptionBinding(): SubscriptionBinding {
  const i18n = useI18n()
  const { t } = i18n
  const store = usePurchasesStore()
  const platform = useShruti().platform

  const legalDocuments = computed<LegalDocument[]>(() => {
    // Privacy policy lives on the marketing site (shruti.app),
    // localized per UI locale (web app src/pages/[lang]/privacy.astro).
    const policyUrl = privacyPolicyUrl(i18n.locale.value as string)
    const docs: LegalDocument[] = [
      { title: t("settings.subscription.legal.privacy"), link: policyUrl },
    ]
    // Apple requires a "Terms of Use" link in any UI that sells a
    // subscription; we point to Apple's standard EULA when the app
    // has no product-specific terms page.
    if (platform === "ios") {
      docs.push({
        title: t("settings.subscription.legal.terms"),
        link: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/",
      })
    }
    return docs
  })

  async function onSubscribe(packageId: string): Promise<void> {
    try {
      await store.purchase(packageId)
    } catch (e) {
      if (e instanceof PurchaseCancelledError) return
      // The store refused the purchase for the device/account (IAP disabled on
      // this build/test track, restrictions, unsupported region). Calm notice,
      // and crucially NOT through showError — that console.errors, which the
      // Sentry captureConsole path would escalate to an issue for an expected
      // store condition.
      if (e instanceof PurchaseNotAllowedError) {
        const alert = await alertController.create({
          header: t("settings.subscription.title"),
          message: t("settings.subscription.unavailable"),
          buttons: [t("app.ok")],
        })
        await alert.present()
        return
      }
      await showError(e)
      return
    }
    if (store.isSubscribed) {
      const alert = await alertController.create({
        header: t("settings.subscription.subscribed"),
        message: t("settings.subscription.thanks"),
        buttons: [t("app.ok")],
      })
      await alert.present()
    }
  }

  async function onRestore(): Promise<void> {
    try {
      await store.restore()
    } catch (e) {
      await showError(e)
      return
    }
    const alert = await alertController.create({
      header: t("settings.subscription.title"),
      message: store.isSubscribed
        ? t("settings.subscription.restored")
        : t("settings.subscription.noSubscriptionFound"),
      buttons: [t("app.ok")],
    })
    await alert.present()
  }

  function onManage(): void {
    const url = store.managementUrl
    if (!url) return
    // Capacitor's webview opens external schemes in the system browser /
    // Play/App Store app — no Browser plugin needed.
    window.open(url, "_blank")
  }

  async function showError(e: unknown): Promise<void> {
    const err = e as { message?: string; underlyingErrorMessage?: string }
    console.error("subscription error", e)
    const alert = await alertController.create({
      header: t("settings.subscription.title"),
      message: [t("settings.subscription.error"), err?.message, err?.underlyingErrorMessage]
        .filter(Boolean)
        .join(" "),
      buttons: [t("app.ok")],
    })
    await alert.present()
  }

  return reactive({
    available: computed(() => store.available),
    isSubscribed: computed(() => store.isSubscribed),
    ready: computed(() => store.ready),
    reconciling: computed(() => store.reconciling),
    packages: computed(() => store.packages),
    purchasing: computed(() => store.purchasing),
    restoring: computed(() => store.restoring),
    appUserId: computed(() => store.appUserId),
    legalDocuments,
    onSubscribe,
    onRestore,
    onManage,
  }) as SubscriptionBinding
}
