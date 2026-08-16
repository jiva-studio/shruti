// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type Component } from "vue"
import type { PackageView } from "../types.js"

/**
 * The paywall withholds the OFFER — an operable Subscribe CTA — while the
 * store's answer to "is this user subscribed?" is still on its way (#1797),
 * and makes it again once no better answer is coming (#1892).
 *
 * `ready` flips after the first, anonymous `getCustomerState()`. An
 * account-tied entitlement only surfaces when the RC.logIn that follows
 * sign-in lands, and `resolved` is false for exactly that gap. A returning
 * subscriber with no local cache — fresh install, reinstall, post-sign-out —
 * is `ready && !isSubscribed` inside it, and the footer used to sell them a
 * subscription they already have.
 *
 * Withholding the offer is not the same as withholding the page, though: the
 * plan cards stay on screen and go inert, because an empty block reads as
 * "there is nothing to buy here" (#1838).
 */

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, te: () => false }),
}))

/** Attrs are inherited so `disabled` reaches the DOM — the difference
 *  between "offered" and "on screen but inert" is the whole subject here. */
const stub = (name: string, tag = "div") =>
  defineComponent({
    name,
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
  resolved?: boolean
  settled?: boolean
  packages?: PackageView[]
}

/** Render the footer and describe what the user is being offered. */
function render(flags: Flags): {
  sells: boolean
  plansVisible: boolean
  loading: boolean
  unconfirmed: boolean
  manage: boolean
} {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const app = createApp(SubscriptionFooter as Component, {
    packages: flags.packages ?? [ANNUAL],
    isSubscribed: flags.isSubscribed ?? false,
    ready: flags.ready ?? true,
    resolved: flags.resolved ?? flags.ready ?? true,
    settled: flags.settled ?? flags.resolved ?? flags.ready ?? true,
    purchasing: false,
    restoring: false,
    legalDocuments: [],
  })
  // Templates read `$t` off the i18n plugin's global properties; the tests
  // assert on KEYS, which is what the branch under test actually selects.
  app.config.globalProperties.$t = (key: string) => key
  app.mount(root)
  const text = root.textContent ?? ""
  const cta = root.querySelector<HTMLButtonElement>("button.IonButton")
  const out = {
    // "Sells" means the user can actually buy — a rendered-but-disabled CTA
    // offers nothing.
    sells: cta !== null && !cta.disabled,
    plansVisible: root.querySelectorAll(".IonItem").length > 0,
    loading: text.includes("settings.subscription.loading"),
    unconfirmed: text.includes("settings.subscription.unconfirmed"),
    manage: root.querySelector(".SubscriptionManageButton") !== null,
  }
  app.unmount()
  root.remove()
  return out
}

describe("SubscriptionFooter — offering a purchase", () => {
  it("offers the plans once the answer is final", () => {
    expect(render({ ready: true, resolved: true })).toMatchObject({
      sells: true,
      plansVisible: true,
      loading: false,
    })
  })

  it("shows the plans inert, not absent, while the answer is open", () => {
    // The #1797 window: ready, not (yet) subscribed, answer not final. The
    // CTA must not be operable — but the block still has to be there, with
    // the note saying why (#1838).
    expect(render({ ready: true, resolved: false })).toMatchObject({
      sells: false,
      plansVisible: true,
      loading: true,
    })
  })

  it("holds the plans inert before the first round-trip too", () => {
    expect(render({ ready: false, resolved: false })).toMatchObject({
      sells: false,
      loading: true,
    })
  })

  it("shows the unavailable note, not loading, when a resolved store has no plans", () => {
    // Builds without IAP keys (RU / web) — permanent, and must not read as
    // a spinner that will finish.
    const out = render({ ready: true, resolved: true, packages: [] })
    expect(out).toMatchObject({ sells: false, plansVisible: false, loading: false })
  })

  it("sells once nothing better is coming, and says the status is unconfirmed", () => {
    // The reconcile blew its budget: the answer is unknown and may never
    // arrive. Staying inert would be permanent, and `ensurePro` routes the
    // user here after exactly that wait (#1892). The cards are the offering,
    // so they operate — with a note aiming an unrecognized subscriber at
    // Restore rather than telling them they are free.
    expect(render({ ready: true, resolved: false, settled: true })).toMatchObject({
      sells: true,
      plansVisible: true,
      loading: false,
      unconfirmed: true,
    })
  })

  it("shows Manage instead of plans once the entitlement is known", () => {
    expect(render({ isSubscribed: true })).toMatchObject({ sells: false, manage: true })
  })

  it("keeps a known subscriber on Manage even when the identity never resolves", () => {
    // Entitlement known, identity unknown. Selling here would be #1797 again,
    // and no amount of "nothing better is coming" makes it right.
    expect(render({ isSubscribed: true, resolved: false, settled: true })).toMatchObject({
      sells: false,
      plansVisible: false,
      manage: true,
    })
  })
})
