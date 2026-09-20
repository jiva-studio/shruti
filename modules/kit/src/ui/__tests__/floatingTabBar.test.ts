import { describe, it, expect } from "vitest"
import { mount } from "@vue/test-utils"
import { FloatingTabBar, type FloatingTab } from "../index.js"

const HEX = /#[0-9a-fA-F]{3,8}\b/

const tabs: FloatingTab[] = [
  { id: "home", ariaLabel: "Home" },
  { id: "settings", ariaLabel: "Settings" },
]

describe("FloatingTabBar", () => {
  it("renders one button per tab with its aria-label and scoped icon", () => {
    const w = mount(FloatingTabBar, {
      props: { tabs, active: "home" },
      slots: { icon: `<i class="ic" :data-id="params.tab.id" />` },
    })
    const buttons = w.findAll(".kit-floating-tabbar__tab")
    expect(buttons).toHaveLength(2)
    expect(buttons[0].attributes("aria-label")).toBe("Home")
    expect(w.findAll(".ic")).toHaveLength(2)
  })

  it("marks the active tab", () => {
    const w = mount(FloatingTabBar, { props: { tabs, active: "settings" } })
    const buttons = w.findAll(".kit-floating-tabbar__tab")
    expect(buttons[0].classes()).not.toContain("kit-floating-tabbar__tab--active")
    expect(buttons[1].classes()).toContain("kit-floating-tabbar__tab--active")
    expect(buttons[1].attributes("aria-current")).toBe("page")
  })

  it("emits select + update:active on tap", async () => {
    const w = mount(FloatingTabBar, { props: { tabs, active: "home" } })
    await w.findAll(".kit-floating-tabbar__tab")[1].trigger("click")
    expect(w.emitted("select")?.[0]).toEqual(["settings"])
    expect(w.emitted("update:active")?.[0]).toEqual(["settings"])
  })

  it("renders the leading slot", () => {
    const w = mount(FloatingTabBar, {
      props: { tabs },
      slots: { leading: `<button class="lead" />` },
    })
    expect(w.find(".lead").exists()).toBe(true)
  })

  it("renders the CTA only when an action-icon slot is provided, and emits action", async () => {
    const without = mount(FloatingTabBar, { props: { tabs } })
    expect(without.find(".kit-floating-tabbar__action").exists()).toBe(false)

    const w = mount(FloatingTabBar, {
      props: { tabs, actionAriaLabel: "Review" },
      slots: { "action-icon": `<i class="rev" />`, "action-badge": "3" },
    })
    const cta = w.find(".kit-floating-tabbar__action")
    expect(cta.exists()).toBe(true)
    expect(cta.attributes("aria-label")).toBe("Review")
    expect(w.find(".kit-floating-tabbar__action-badge").text()).toBe("3")
    await cta.trigger("click")
    expect(w.emitted("action")).toHaveLength(1)
  })

  it("muting the CTA suppresses pulse and sets aria-disabled", () => {
    const w = mount(FloatingTabBar, {
      props: { tabs, actionDisabled: true, actionPulse: true },
      slots: { "action-icon": `<i class="rev" />` },
    })
    const cta = w.find(".kit-floating-tabbar__action")
    expect(cta.classes()).toContain("kit-floating-tabbar__action--disabled")
    expect(cta.classes()).not.toContain("kit-floating-tabbar__action--pulse")
    expect(cta.attributes("aria-disabled")).toBe("true")
  })

  it("hardcodes no hex colours (everything is token-driven)", () => {
    const w = mount(FloatingTabBar, {
      props: { tabs, active: "home" },
      slots: { "action-icon": `<i class="rev" />`, "action-badge": "1" },
    })
    expect(w.html()).not.toMatch(HEX)
  })
})
