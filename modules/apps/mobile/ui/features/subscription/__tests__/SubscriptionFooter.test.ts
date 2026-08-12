// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type Component } from "vue"
import type { PackageView } from "../types.js"

/**
 * The paywall may only report "not subscribed" — plan cards plus the
 * Subscribe CTA — once the store's answer is FINAL (#1797).
 *
 * `ready` flips after the first, anonymous `getCustomerState()`. An
 * account-tied entitlement only surfaces when the RC.logIn that follows
 * sign-in lands, and `reconciling` is up for exactly that gap. A returning
 * subscriber with no local cache — fresh install, reinstall, post-sign-out —
 * is `ready && !isSubscribed` inside it, and the footer used to sell them a
 * subscription they already have.
 */

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, te: () => false }),
}))

const stub = (name: string, tag = "div") =>
  defineComponent({
    name,
    inheritAttrs: false,
    setup:
      (_p, { slots }) =>
      () =>
        h(tag, { class: name }, slots.default?.()),
  })

vi.mock("@ionic/vue", () => ({
  IonButton: stub("IonButton", "button"),
  IonIcon: stub("IonIcon", "span"),
  IonItem: stub("IonItem"),
  IonLabel: stub("IonLabel"),
  IonNote: stub("IonNote"),
}))
vi.mock("@tabler/icons-vue", () => ({ IconStarFilled: stub("IconStarFilled", "span") }))
vi.mock("ionicons/icons", () => ({ checkmarkCircle: "checkmark" }))
vi.mock("../SubscriptionManageButton.vue", () => ({ default: stub("SubscriptionManageButton") }))
vi.mock("../SubscriptionDisclaimer.vue", () => ({ default: stub("SubscriptionDisclaimer") }))
vi.mock("../SubscriptionLinks.vue", () => ({ default: stub("SubscriptionLinks") }))

const { default: SubscriptionFooter } = await import("../SubscriptionFooter.vue")

const ANNUAL: PackageView = {
  packageId: "$rc_annual",
  priceString: "$19.99",
  billingPeriod: "P1Y",
}

interface Flags {
  isSubscribed?: boolean
  ready?: boolean
  reconciling?: boolean
  packages?: PackageView[]
}

/** Render the footer and describe what the user is being offered. */
function render(flags: Flags): { sells: boolean; loading: boolean; manage: boolean } {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const app = createApp(SubscriptionFooter as Component, {
    packages: flags.packages ?? [ANNUAL],
    isSubscribed: flags.isSubscribed ?? false,
    ready: flags.ready ?? true,
    reconciling: flags.reconciling ?? false,
    purchasing: false,
    restoring: false,
    legalDocuments: [],
  })
  // Templates read `$t` off the i18n plugin's global properties; the tests
  // assert on KEYS, which is what the branch under test actually selects.
  app.config.globalProperties.$t = (key: string) => key
  app.mount(root)
  const text = root.textContent ?? ""
  const out = {
    sells: root.querySelector(".IonButton") !== null,
    loading: text.includes("settings.subscription.loading"),
    manage: root.querySelector(".SubscriptionManageButton") !== null,
  }
  app.unmount()
  root.remove()
  return out
}

describe("SubscriptionFooter — offering a purchase", () => {
  it("offers the plans only when ready and not reconciling", () => {
    expect(render({ ready: true, reconciling: false })).toMatchObject({
      sells: true,
      loading: false,
    })
  })

  it("holds the plans behind the loading note while an RC login is in flight", () => {
    // The #1797 window: ready, not (yet) subscribed, answer not final.
    expect(render({ ready: true, reconciling: true })).toMatchObject({
      sells: false,
      loading: true,
    })
  })

  it("holds the plans behind the loading note before the first round-trip", () => {
    expect(render({ ready: false, reconciling: false })).toMatchObject({
      sells: false,
      loading: true,
    })
  })

  it("shows the unavailable note, not loading, when a resolved store has no plans", () => {
    // Builds without IAP keys (RU / web) — permanent, and must not read as
    // a spinner that will finish.
    const out = render({ ready: true, reconciling: false, packages: [] })
    expect(out).toMatchObject({ sells: false, loading: false })
  })

  it("shows Manage instead of plans once the entitlement is known", () => {
    expect(render({ isSubscribed: true })).toMatchObject({ sells: false, manage: true })
  })
})
