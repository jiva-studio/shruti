import { describe, it, expect, beforeAll } from "vitest"
import { defineComponent, h } from "vue"
import { mount } from "@vue/test-utils"
import {
  SettingsGroup,
  SettingsItem,
  SettingsToggleItem,
  SettingsSelectItem,
  SettingsTimeItem,
  SettingsActionItem,
  SettingsAccountItem,
} from "../index.js"

// The settings shells are built on real Ionic web components. Under jsdom the
// custom elements aren't auto-registered, so we exercise OUR template logic
// (slots, props, computed display, emitted events) against the rendered Ionic
// tags (ion-item, ion-label, ion-toggle, …). Vue's @click / @ion-change
// listeners are attached to those host elements, so DOM events on them reach
// our handlers without booting Ionic's full runtime.

const HEX = /#[0-9a-fA-F]{3,8}\b/

// jsdom doesn't define the custom elements; stub them as inert HTMLElements so
// nothing throws on upgrade. Querying still works by tag name.
beforeAll(() => {
  for (const tag of ["ion-item", "ion-label", "ion-list", "ion-list-header", "ion-toggle"]) {
    if (!customElements.get(tag)) {
      customElements.define(tag, class extends HTMLElement {})
    }
  }
})

// IonToggle is driven via the `ion-change` CustomEvent and a controlled
// `checked` prop. Its real web-component internals don't run under jsdom, so we
// stub it with a tiny Vue component that mirrors that contract — exposing the
// controlled `checked` and re-emitting `ion-change` on click — to assert our
// component reflects the prop and updates the model.
const IonToggleStub = defineComponent({
  name: "IonToggle",
  props: { checked: { type: Boolean, default: false } },
  emits: ["ion-change"],
  setup(props, { emit }) {
    return () =>
      h("button", {
        class: "ion-toggle-stub",
        "data-checked": String(props.checked),
        onClick: () => emit("ion-change", { detail: { checked: !props.checked } }),
      })
  },
})
const toggleGlobal = { stubs: { IonToggle: IonToggleStub } }

describe("SettingsItem", () => {
  it("renders title/subtitle props", () => {
    const w = mount(SettingsItem, { props: { title: "Server", subtitle: "Europe" } })
    expect(w.find("h2").text()).toBe("Server")
    expect(w.find("p").text()).toBe("Europe")
  })

  it("renders icon and trailing slots", () => {
    const w = mount(SettingsItem, {
      props: { title: "X" },
      slots: { icon: "<i class='ic' />", trailing: "<span class='tr'>on</span>" },
    })
    expect(w.find(".kit-settings-item-icon .ic").exists()).toBe(true)
    expect(w.find(".kit-settings-item-trailing .tr").text()).toBe("on")
  })

  it("emits activate on click", async () => {
    const w = mount(SettingsItem, { props: { title: "X", button: true } })
    await w.find("ion-item").trigger("click")
    expect(w.emitted("activate")).toHaveLength(1)
  })

  it("applies the danger class", () => {
    const w = mount(SettingsItem, { props: { title: "X", danger: true } })
    expect(w.find(".kit-settings-item--danger").exists()).toBe(true)
  })

  it("hardcodes no hex colours (token-driven)", () => {
    const w = mount(SettingsItem, { props: { title: "X", danger: true, detail: true } })
    expect(w.html()).not.toMatch(HEX)
  })
})

describe("SettingsGroup", () => {
  it("renders the title and default slot rows", () => {
    const w = mount(SettingsGroup, {
      props: { title: "Appearance" },
      slots: { default: "<div class='row'>row</div>" },
    })
    expect(w.find("ion-list-header").text()).toBe("Appearance")
    expect(w.find("ion-list .row").exists()).toBe(true)
  })

  it("renders header/footer slots and props", () => {
    const propVariant = mount(SettingsGroup, { props: { footer: "Help text" } })
    expect(propVariant.find(".kit-settings-group-footer").text()).toBe("Help text")

    const slotVariant = mount(SettingsGroup, {
      slots: { header: "<h3 class='h'>Hi</h3>", footer: "<small class='f'>note</small>" },
    })
    expect(slotVariant.find("ion-list-header .h").exists()).toBe(true)
    expect(slotVariant.find(".kit-settings-group-footer .f").exists()).toBe(true)
  })

  it("omits header/footer when neither prop nor slot is given", () => {
    const w = mount(SettingsGroup, { slots: { default: "<div>x</div>" } })
    expect(w.find("ion-list-header").exists()).toBe(false)
    expect(w.find(".kit-settings-group-footer").exists()).toBe(false)
  })

  it("hardcodes no hex colours (token-driven)", () => {
    const w = mount(SettingsGroup, { props: { title: "X", footer: "y" } })
    expect(w.html()).not.toMatch(HEX)
  })
})

describe("SettingsToggleItem", () => {
  it("renders the label and reflects the checked model", () => {
    const w = mount(SettingsToggleItem, {
      props: { title: "Notifications", checked: true },
      global: toggleGlobal,
    })
    expect(w.find("h2").text()).toBe("Notifications")
    expect(w.find(".ion-toggle-stub").attributes("data-checked")).toBe("true")
  })

  it("updates v-model:checked on toggle", async () => {
    const w = mount(SettingsToggleItem, {
      props: { title: "X", checked: false },
      global: toggleGlobal,
    })
    await w.find(".ion-toggle-stub").trigger("click")
    expect(w.emitted("update:checked")).toEqual([[true]])
  })
})

describe("SettingsSelectItem", () => {
  it("resolves the current value to its option title", () => {
    const w = mount(SettingsSelectItem, {
      props: {
        title: "Language",
        modelValue: "en",
        options: [
          { id: "en", title: "English" },
          { id: "ru", title: "Russian" },
        ],
      },
    })
    expect(w.find("p").text()).toBe("English")
  })

  it("prefers an explicit subtitle over the resolved option", () => {
    const w = mount(SettingsSelectItem, {
      props: { title: "Server", modelValue: "a", subtitle: "Europe (auto)" },
    })
    expect(w.find("p").text()).toBe("Europe (auto)")
  })

  it("emits activate and select on tap", async () => {
    const w = mount(SettingsSelectItem, { props: { title: "X", modelValue: "ru" } })
    await w.find("ion-item").trigger("click")
    expect(w.emitted("activate")).toHaveLength(1)
    expect(w.emitted("select")).toEqual([["ru"]])
  })
})

describe("SettingsTimeItem", () => {
  it("formats the time as zero-padded HH : MM", () => {
    const w = mount(SettingsTimeItem, {
      props: { title: "Reminder", time: [9, 5] as [number, number] },
    })
    expect(w.find(".kit-settings-time-chip").text()).toBe("09 : 05")
  })

  it("falls back when no time is set", () => {
    const w = mount(SettingsTimeItem, {
      props: { title: "Reminder", time: undefined, fallback: [7, 30] as [number, number] },
    })
    expect(w.find(".kit-settings-time-chip").text()).toBe("07 : 30")
  })

  it("emits activate on tap", async () => {
    const w = mount(SettingsTimeItem, { props: { title: "X" } })
    await w.find("ion-item").trigger("click")
    expect(w.emitted("activate")).toHaveLength(1)
  })
})

describe("SettingsActionItem", () => {
  it("emits activate on tap", async () => {
    const w = mount(SettingsActionItem, { props: { title: "Export", danger: false } })
    await w.find("ion-item").trigger("click")
    expect(w.emitted("activate")).toHaveLength(1)
  })

  it("applies danger styling", () => {
    const w = mount(SettingsActionItem, { props: { title: "Delete", danger: true } })
    expect(w.find(".kit-settings-item--danger").exists()).toBe(true)
  })
})

describe("SettingsAccountItem", () => {
  it("shows name and derives initials", () => {
    const w = mount(SettingsAccountItem, {
      props: { signedIn: true, name: "Ada Lovelace", subtitle: "Signed in" },
    })
    expect(w.find("h2").text()).toBe("Ada Lovelace")
    expect(w.find(".kit-settings-account-initials").text()).toBe("AL")
  })

  it("emits activate on tap", async () => {
    const w = mount(SettingsAccountItem, { props: { title: "Sign in" } })
    await w.find("ion-item").trigger("click")
    expect(w.emitted("activate")).toHaveLength(1)
  })
})
