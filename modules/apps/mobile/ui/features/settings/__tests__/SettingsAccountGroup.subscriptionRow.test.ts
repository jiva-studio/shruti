// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type Component } from "vue"

/**
 * The subscription row has three states and must occupy the slot in all of
 * them. `isSubscribed` gates "manage" and `subscriptionResolved` gates the
 * sell row (#1797) — which left the third state, "not known yet", rendering
 * nothing at all: on every cold start the row simply disappeared from the
 * Account group, with no skeleton and no disabled state to explain it
 * (#1838).
 */

const stub = (name: string, tag = "div") =>
  defineComponent({
    name,
    props: { title: String, subtitle: String, disabled: Boolean },
    setup:
      (p, { slots }) =>
      () =>
        h(tag, { class: name, "data-disabled": String(Boolean(p.disabled)) }, [
          p.title ?? "",
          " ",
          p.subtitle ?? "",
          slots.default?.(),
        ]),
  })

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@ionic/vue", () => ({
  IonActionSheet: stub("IonActionSheet"),
  IonLabel: stub("IonLabel"),
  IonListHeader: stub("IonListHeader"),
}))
vi.mock("@kit/ui", () => ({
  SettingsAccountItem: stub("SettingsAccountItem"),
  SettingsActionItem: stub("SettingsActionItem"),
}))
vi.mock("@tabler/icons-vue", () => ({
  IconCrownFilled: stub("IconCrownFilled", "span"),
  IconUserFilled: stub("IconUserFilled", "span"),
  IconUserPlus: stub("IconUserPlus", "span"),
}))
vi.mock("@ui/primitives/index.js", () => ({ IconChip: stub("IconChip", "span") }))
vi.mock("../ServerSettingsItem.vue", () => ({ default: stub("ServerSettingsItem") }))

const { default: SettingsAccountGroup } = await import("../groups/SettingsAccountGroup.vue")

interface Flags {
  isSubscribed?: boolean
  subscriptionResolved?: boolean
}

/** Render the group and describe the subscription row it produced. */
function renderRow(flags: Flags): { title: string; disabled: boolean } | null {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const app = createApp(SettingsAccountGroup as Component, {
    anonymous: false,
    email: "user@example.com",
    // eslint-disable-next-line vue/multi-word-component-names -- account display name, not a component
    name: "Test User",
    picture: null,
    isSubscribed: flags.isSubscribed ?? false,
    subscriptionResolved: flags.subscriptionResolved ?? true,
    serverItems: [],
    activeServerId: "s1",
  })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(root)
  // The account row is a SettingsAccountItem; every SettingsActionItem in the
  // group is the subscription row (delete/sign-out live in action sheets).
  const row = root.querySelector(".SettingsActionItem")
  const out = row
    ? {
        title: (row.textContent ?? "").trim(),
        disabled: row.getAttribute("data-disabled") === "true",
      }
    : null
  app.unmount()
  root.remove()
  return out
}

describe("SettingsAccountGroup — the subscription row", () => {
  it("offers management to a known subscriber", () => {
    const row = renderRow({ isSubscribed: true })
    expect(row?.title).toContain("settings.subscription.subscriptionIsActive")
    expect(row?.disabled).toBe(false)
  })

  it("sells once the answer is final and negative", () => {
    const row = renderRow({ isSubscribed: false, subscriptionResolved: true })
    expect(row?.title).toContain("settings.subscription.description")
    expect(row?.disabled).toBe(false)
  })

  it("holds the slot with a disabled row while the answer is open", () => {
    const row = renderRow({ isSubscribed: false, subscriptionResolved: false })
    // Present — not a gap in the list — and inert, so nothing is offered
    // to someone who may already pay.
    expect(row).not.toBeNull()
    expect(row?.title).toContain("settings.subscription.loading")
    expect(row?.disabled).toBe(true)
  })
})
