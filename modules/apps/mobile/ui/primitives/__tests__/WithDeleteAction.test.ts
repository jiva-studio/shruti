// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type App } from "vue"

/* -- Module doubles ---------------------------------------------------- */

const passthrough = (tag: string, name: string) =>
  defineComponent({
    name,
    setup:
      (_props, { slots }) =>
      () =>
        h(tag, slots.default?.()),
  })

vi.mock("@ionic/vue", () => ({
  IonItemSliding: passthrough("ion-item-sliding", "IonItemSliding"),
  IonItemOptions: passthrough("ion-item-options", "IonItemOptions"),
  IonItemOption: passthrough("ion-item-option", "IonItemOption"),
}))
vi.mock("@tabler/icons-vue", () => ({
  IconTrashFilled: defineComponent({ name: "IconTrashFilled", setup: () => () => h("trash-icon") }),
}))

const { default: WithDeleteAction } = await import("../WithDeleteAction.vue")

/* -- Harness ----------------------------------------------------------- */

let app: App | null = null

interface Rendered {
  readonly host: HTMLElement
  readonly deletes: number
}

function render(): Rendered {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const rendered = { host, deletes: 0 }
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(
          WithDeleteAction,
          { onDelete: () => (rendered.deletes += 1) },
          { default: () => h("div", { class: "row" }, "Sweetness of Bhakti") }
        ),
    })
  )
  app.mount(host)
  return rendered
}

const deleteOption = (host: HTMLElement): HTMLElement | null =>
  host.querySelector("ion-item-option")

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

/* -- Cases ------------------------------------------------------------- */

describe("WithDeleteAction", () => {
  it("shows the wrapped row", () => {
    const { host } = render()
    expect(host.querySelector(".row")?.textContent).toBe("Sweetness of Bhakti")
  })

  it("offers a trash action behind the row", () => {
    const { host } = render()
    expect(deleteOption(host)).not.toBeNull()
    expect(host.querySelector("ion-item-option trash-icon")).not.toBeNull()
  })

  it("asks the owner to delete when the action is tapped", () => {
    const rendered = render()
    deleteOption(rendered.host)!.click()
    expect(rendered.deletes).toBe(1)
  })

  it("stays silent until the action is tapped", () => {
    const rendered = render()
    rendered.host.querySelector<HTMLElement>(".row")!.click()
    expect(rendered.deletes).toBe(0)
  })

  it("reports every tap, so a repeated swipe-delete is not swallowed", () => {
    const rendered = render()
    deleteOption(rendered.host)!.click()
    deleteOption(rendered.host)!.click()
    expect(rendered.deletes).toBe(2)
  })
})
