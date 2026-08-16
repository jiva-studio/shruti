import { computed, reactive } from "vue"
import { useI18n } from "vue-i18n"
import { alertController } from "@ionic/vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { privacyPolicyUrl } from "@lectorium/i18n/index.js"
import { usePurchasesStore } from "@lectorium/stores/usePurchasesStore.js"
import type { SubscriptionFeatureKey } from "@ui/features/subscription/index.js"
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
   * `true` while an RC.logIn/logOut is in flight and still inside its
   * budget — i.e. "the answer is coming, show progress". It drops after
   * five seconds even if RevenueCat hasn't answered, so nothing spins
   * forever; `resolved` is what says the answer actually arrived.
   */
  readonly reconciling: boolean
  /**
   * The store's answer to "is this user subscribed?" is final. Every
   * surface that gates a Pro feature or opens the paywall reads THIS, not
   * `ready`: a returning subscriber with no local cache is `ready` but not
   * yet subscribed for the length of the RC.logIn round-trip. False also
   * covers "the reconcile blew its budget" — the answer is then unknown,
   * which is not the same as "not subscribed".
   */
  readonly resolved: boolean
  /**
   * No better answer is coming — the reconcile settled or gave up. The
   * purchase block operates on this rather than `resolved`, because the
   * plans come from the offering and an unknown entitlement is no reason to
   * refuse a sale (#1892).
   */
  readonly settled: boolean
  readonly packages: PurchasePackage[]
  readonly purchasing: boolean
  readonly restoring: boolean
  readonly legalDocuments: LegalDocument[]
  /** RC-side customer id; surfaced in the debug build-info footer. */
  readonly appUserId: string | undefined
  /**
   * Gate a Pro control on the FINAL entitlement answer, opening the paywall
   * when it really is a no. See usePurchasesStore.ensurePro — the point is
   * that a tap inside the reconcile window becomes a short wait rather than
   * a dropped tap or a sales pitch aimed at a subscriber.
   */
  ensurePro: (feature?: SubscriptionFeatureKey) => Promise<boolean>
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
  const platform = useLectorium().platform

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
    resolved: computed(() => store.resolved),
    settled: computed(() => store.settled),
    packages: computed(() => store.packages),
    purchasing: computed(() => store.purchasing),
    restoring: computed(() => store.restoring),
    appUserId: computed(() => store.appUserId),
    legalDocuments,
    ensurePro: (feature?: SubscriptionFeatureKey) => store.ensurePro(feature),
    onSubscribe,
    onRestore,
    onManage,
  }) as SubscriptionBinding
}
