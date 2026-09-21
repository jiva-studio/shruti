// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"

/* -- Module doubles ----------------------------------------------------- */

const stub = (name: string, tag = "div") =>
  defineComponent({
    name,
    props: { title: String, subtitle: String, disabled: Boolean },
    setup:
      (p, { slots }) =>
      () =>
        h(tag, { class: name }, [p.title ?? "", slots.default?.()]),
  })

interface SheetButton {
  readonly text: string
  readonly role?: string
  readonly handler?: () => void
}

/** The sheets as real DOM. Ionic dismisses on any button press, handler or
 *  not, so the stub reports that dismissal the same way. */
const ActionSheetStub = defineComponent({
  name: "IonActionSheet",
  props: { isOpen: Boolean, buttons: { type: Array, default: () => [] } },
  emits: ["didDismiss"],
  setup:
    (props, { emit }) =>
    () =>
      props.isOpen
        ? h(
            "div",
            { class: "sheet" },
            (props.buttons as SheetButton[]).map((b) =>
              h(
                "button",
                {
                  class: `sheet-btn role-${b.role ?? "none"}`,
                  onClick: () => {
                    b.handler?.()
                    emit("didDismiss")
                  },
                },
                b.text
              )
            )
          )
        : null,
})

/** The account row: a button that reports whether it is currently inert. */
const AccountRowStub = defineComponent({
  name: "SettingsAccountRow",
  props: { anonymous: Boolean, disabled: Boolean },
  emits: ["activate"],
  setup:
    (p, { emit }) =>
    () =>
      h("button", {
        class: "account-row",
        "data-disabled": String(p.disabled),
        onClick: () => emit("activate"),
      }),
})

/** The server picker, as the one control that writes back through v-model. */
const ServerItemStub = defineComponent({
  name: "ServerSettingsItem",
  props: { modelValue: String, items: { type: Array, default: () => [] } },
  emits: ["update:modelValue"],
  setup:
    (p, { emit }) =>
    () =>
      h(
        "button",
        { class: "server-item", onClick: () => emit("update:modelValue", "s2") },
        String(p.modelValue)
      ),
})

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("@ionic/vue", () => ({
  IonActionSheet: ActionSheetStub,
  IonLabel: stub("IonLabel"),
  IonListHeader: stub("IonListHeader"),
}))
vi.mock("@kit/ui", () => ({ SettingsActionItem: stub("SettingsActionItem") }))
vi.mock("@tabler/icons-vue", () => ({ IconCrownFilled: stub("IconCrownFilled", "span") }))
vi.mock("@ui/primitives/index.js", () => ({ IconChip: stub("IconChip", "span") }))
vi.mock("../ServerSettingsItem.vue", () => ({ default: ServerItemStub }))
vi.mock("../SettingsAccountRow.vue", () => ({ default: AccountRowStub }))

const { default: SettingsAccountGroup } = await import("../groups/SettingsAccountGroup.vue")

type GroupProps = InstanceType<typeof SettingsAccountGroup>["$props"]

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

interface Emitted {
  readonly signIn: number
  readonly signOut: number
  readonly deletes: { wipeLocal: boolean }[]
  readonly servers: string[]
}

function render(over: Partial<GroupProps> = {}): { host: HTMLElement; emitted: Emitted } {
  const emitted = {
    signIn: 0,
    signOut: 0,
    deletes: [] as { wipeLocal: boolean }[],
    servers: [] as string[],
  }
  const host = document.createElement("div")
  document.body.appendChild(host)
  const props: GroupProps = {
    anonymous: false,
    email: "user@example.com",
    name: "Test User",
    picture: null,
    isSubscribed: false,
    subscriptionResolved: true,
    serverItems: [
      { id: "s1", title: "Europe" },
      { id: "s2", title: "Russia" },
    ],
    activeServerId: "s1",
    "onSign-in-anonymous": () => void (emitted.signIn += 1),
    "onSign-out": () => void (emitted.signOut += 1),
    "onDelete-account": (opts: { wipeLocal: boolean }) => void emitted.deletes.push(opts),
    "onPreferred-server-change": (id: string) => void emitted.servers.push(id),
    ...over,
  }
  app = createApp(SettingsAccountGroup, { ...props })
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return { host, emitted: emitted as Emitted }
}

const press = (host: HTMLElement, sel: string): void =>
  void (host.querySelector(sel) as HTMLButtonElement).click()

const buttonTexts = (host: HTMLElement): string[] =>
  [...host.querySelectorAll(".sheet-btn")].map((b) => b.textContent ?? "")

describe("tapping the account row", () => {
  it("starts the sign-in flow for an anonymous user instead of opening a sheet", async () => {
    const { host, emitted } = render({ anonymous: true, email: null, name: null })

    press(host, ".account-row")
    await nextTick()

    expect(emitted.signIn).toBe(1)
    expect(host.querySelector(".sheet")).toBeNull()
  })

  it("offers sign-out and account deletion to a signed-in user", async () => {
    const { host, emitted } = render()

    press(host, ".account-row")
    await nextTick()

    expect(buttonTexts(host)).toEqual([
      "settings.account.signOut",
      "settings.account.deleteAccount.title",
      "app.cancel",
    ])
    expect(emitted.signIn).toBe(0)
  })

  it("signs the user out from the sheet", async () => {
    const { host, emitted } = render()

    press(host, ".account-row")
    await nextTick()
    press(host, ".sheet-btn")
    await nextTick()

    expect(emitted.signOut).toBe(1)
  })

  it("does nothing when the sheet is dismissed", async () => {
    const { host, emitted } = render()

    press(host, ".account-row")
    await nextTick()
    press(host, ".role-cancel")
    await nextTick()

    expect(emitted).toMatchObject({ signOut: 0, deletes: [] })
    expect(host.querySelector(".sheet")).toBeNull()
  })
})

describe("deleting the account", () => {
  /** Walk from the row to the second sheet, where the two deletes live. */
  async function openConfirm(): Promise<{ host: HTMLElement; emitted: Emitted }> {
    const rendered = render()
    press(rendered.host, ".account-row")
    await nextTick()
    const del = [...rendered.host.querySelectorAll(".sheet-btn")].find(
      (b) => b.textContent === "settings.account.deleteAccount.title"
    ) as HTMLButtonElement
    del.click()
    await nextTick()
    return rendered
  }

  it("asks what to do with the device's data before deleting anything", async () => {
    const { host, emitted } = await openConfirm()

    expect(buttonTexts(host)).toEqual([
      "settings.account.deleteAccount.confirmWipe",
      "settings.account.deleteAccount.confirmKeep",
      "app.cancel",
    ])
    expect(emitted.deletes).toEqual([])
  })

  it("wipes the device's data when that is the answer", async () => {
    const { host, emitted } = await openConfirm()

    press(host, ".sheet-btn")
    await nextTick()

    expect(emitted.deletes).toEqual([{ wipeLocal: true }])
  })

  it("keeps the device's data when that is the answer", async () => {
    const { host, emitted } = await openConfirm()

    const keep = [...host.querySelectorAll(".sheet-btn")].find(
      (b) => b.textContent === "settings.account.deleteAccount.confirmKeep"
    ) as HTMLButtonElement
    keep.click()
    await nextTick()

    expect(emitted.deletes).toEqual([{ wipeLocal: false }])
  })

  it("deletes nothing when the confirmation is dismissed", async () => {
    const { host, emitted } = await openConfirm()

    press(host, ".role-cancel")
    await nextTick()

    expect(emitted.deletes).toEqual([])
    expect(host.querySelector(".sheet")).toBeNull()
  })
})

describe("the preferred server", () => {
  it("reports a new pick upwards, leaving the shown value to the parent", async () => {
    const { host, emitted } = render()

    press(host, ".server-item")
    await nextTick()

    expect(emitted.servers).toEqual(["s2"])
    // Nothing flips locally: the row still shows what the props say.
    expect(host.querySelector(".server-item")?.textContent).toBe("s1")
  })

  it("stays quiet when the pick is the server already in use", async () => {
    const { host, emitted } = render({ activeServerId: "s2" })

    press(host, ".server-item")
    await nextTick()

    expect(emitted.servers).toEqual([])
  })
})
