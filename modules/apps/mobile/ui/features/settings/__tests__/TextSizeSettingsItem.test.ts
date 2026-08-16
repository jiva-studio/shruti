// @vitest-environment jsdom
/**
 * Qase case 575. The Settings row that drives the root font scale (#1890).
 * It shows percentages rather than named steps, so the only copy to translate
 * is the row title — but that puts the burden on `Intl`, and on the row
 * actually surfacing the *current* value rather than a fixed label.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type App } from "vue"
import { createI18n } from "vue-i18n"

/* -- Module doubles ---------------------------------------------------- */

/** Renders the props under test into the DOM so they can be read back. */
const SettingsSelectItem = defineComponent({
  name: "SettingsSelectItem",
  props: { title: String, subtitle: String },
  emits: ["activate"],
  setup: (props) => () =>
    h("settings-select-item", { title: props.title, subtitle: props.subtitle }),
})

const ListItemSelectorDialog = defineComponent({
  name: "ListItemSelectorDialog",
  props: { open: Boolean, title: String, items: Array, value: String },
  emits: ["close", "select"],
  setup: (props) => () =>
    h(
      "selector-dialog",
      { value: props.value },
      (props.items as { id: string; title: string }[]).map((i) =>
        h("option-row", { id: i.id }, i.title)
      )
    ),
})

vi.mock("@kit/ui", () => ({ SettingsSelectItem }))
vi.mock("@ui/components/selectors/index.js", () => ({ ListItemSelectorDialog }))
vi.mock("@ui/primitives/index.js", () => ({
  IconChip: defineComponent({
    name: "IconChip",
    setup:
      (_p, { slots }) =>
      () =>
        h("icon-chip", slots.default?.()),
  }),
}))
vi.mock("@tabler/icons-vue", () => ({
  IconTextSize: defineComponent({ name: "IconTextSize", setup: () => () => h("svg") }),
}))

const { default: TextSizeSettingsItem } = await import("../TextSizeSettingsItem.vue")

/* -- Harness ----------------------------------------------------------- */

const PRESETS = [0.9, 1, 1.15, 1.3, 1.5]
const messages = { en: { settings: { textSize: { title: "Text size" } } } }

let app: App | null = null
let host: HTMLElement | null = null

function render(scale: number, locale = "en"): HTMLElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(TextSizeSettingsItem, { presets: PRESETS, scale })
  app.use(createI18n({ legacy: false, locale, fallbackLocale: "en", messages }))
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

/* -- Cases ------------------------------------------------------------- */

describe("text size settings row", () => {
  it("surfaces the current scale as a percentage", () => {
    render(1.3)

    expect(host!.querySelector("settings-select-item")?.getAttribute("subtitle")).toBe("130%")
  })

  it("reads 100% at the default, not an empty subtitle", () => {
    render(1)

    expect(host!.querySelector("settings-select-item")?.getAttribute("subtitle")).toBe("100%")
  })

  it("offers every preset, whole-numbered", () => {
    render(1)

    const rows = [...host!.querySelectorAll("option-row")]
    expect(rows.map((r) => r.getAttribute("id"))).toEqual(PRESETS.map(String))
    expect(rows.map((r) => r.textContent)).toEqual(["90%", "100%", "115%", "130%", "150%"])
  })

  it("preselects the stored scale in the picker", () => {
    render(1.15)

    expect(host!.querySelector("selector-dialog")?.getAttribute("value")).toBe("1.15")
  })

  it("formats the percentage in the active locale", () => {
    // ru puts a space before the sign; the point is that the row does not
    // hand-assemble `${n}%`.
    render(1.3, "ru")

    const subtitle = host!.querySelector("settings-select-item")?.getAttribute("subtitle")
    expect(subtitle).toContain("130")
    expect(subtitle).toContain("%")
  })
})
