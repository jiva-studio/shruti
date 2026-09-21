// @vitest-environment jsdom
/**
 * The card is a teaser for a setting the user is about to hand over to the
 * assistant, so it has to say how much the proposed filter covers — per
 * dimension, and only for the dimensions that carry anything.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, type App } from "vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@shruti/stores/useChatStore.js"

vi.mock("@ionic/vue", () => ({
  IonSpinner: defineComponent({ name: "IonSpinner", setup: () => () => h("ion-spinner") }),
}))
vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && "n" in params ? `${key}:${String(params.n)}` : key,
  }),
}))

const { default: ActionCardConfigureSmartLibrary } =
  await import("../ActionCardConfigureSmartLibrary.vue")

type ConfigurePayload = Extract<ChatActionPayload, { kind: "configure_smart_library" }>

function payload(filters: ConfigurePayload["filters"] = {}): ConfigurePayload {
  return { kind: "configure_smart_library", id: "act-1", filters }
}

let app: App | null = null

interface Rendered {
  readonly host: HTMLElement
  readonly confirms: string[]
}

function render(value: ConfigurePayload | undefined, state: ActionState = "pending"): Rendered {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const confirms: string[] = []
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(ActionCardConfigureSmartLibrary, {
          actionId: "act-1",
          payload: value,
          state,
          onConfirm: (actionId: string) => confirms.push(actionId),
        }),
    })
  )
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return { host, confirms }
}

const chips = (host: HTMLElement): string[] =>
  Array.from(host.querySelectorAll(".chip")).map((el) => el.textContent ?? "")

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

describe("ActionCardConfigureSmartLibrary", () => {
  it("shows the degraded placeholder when the payload never arrived", () => {
    const { host } = render(undefined)

    expect(host.querySelector(".broken")).not.toBeNull()
    expect(host.querySelector(".body")).toBeNull()
  })

  it("counts each dimension the proposed filter covers, in card order", () => {
    const { host } = render(
      payload({
        languageCodes: ["ru"],
        authorIds: ["a-1", "a-2"],
        tagIds: ["t-1"],
      })
    )

    expect(chips(host)).toEqual([
      "chat.actionConfigureSmartLibraryChipAuthors:2",
      "chat.actionConfigureSmartLibraryChipTopics:1",
      "chat.actionConfigureSmartLibraryChipLanguages:1",
    ])
  })

  it("shows no chip row for a filter that covers nothing", () => {
    const { host } = render(payload({ authorIds: [], tagIds: [] }))

    expect(host.querySelector(".filter-chips")).toBeNull()
    expect(host.querySelector(".body")).not.toBeNull()
  })

  it("shows no chip row when the payload names no dimension at all", () => {
    const { host } = render(payload({}))

    expect(host.querySelector(".filter-chips")).toBeNull()
  })

  it("hands the action id back on confirm", async () => {
    const rendered = render(payload({ sourceIds: ["bg"] }))
    rendered.host.querySelector<HTMLButtonElement>(".btn")!.click()
    await nextTick()

    expect(rendered.confirms).toEqual(["act-1"])
  })

  it("offers a retry after a failure, with the chips still shown", async () => {
    const rendered = render(payload({ locationIds: ["vrindavan"] }), "error")
    expect(chips(rendered.host)).toEqual(["chat.actionConfigureSmartLibraryChipLocations:1"])

    rendered.host.querySelector<HTMLButtonElement>(".btn")!.click()
    await nextTick()
    expect(rendered.confirms).toEqual(["act-1"])
  })

  it("says the library was configured once it is done", () => {
    const { host } = render(payload({ authorIds: ["a-1"] }), "done")

    expect(host.querySelector(".hint")?.textContent).toBe("chat.actionConfigureSmartLibraryDone")
    expect(host.querySelector(".btn")).toBeNull()
  })
})
