import { describe, it, expect } from "vitest"
import { mount } from "@vue/test-utils"
import { SectionHeader, Badge, Heatmap, type HeatmapCell } from "../index.js"

const HEX = /#[0-9a-fA-F]{3,8}\b/

describe("SectionHeader", () => {
  it("renders the title", () => {
    const w = mount(SectionHeader, { props: { title: "ACTIVITY" } })
    expect(w.find(".section-header-title").text()).toBe("ACTIVITY")
  })

  it("renders the trailing slot only when provided", () => {
    const without = mount(SectionHeader, { props: { title: "X" } })
    expect(without.find(".section-header-trailing").exists()).toBe(false)
    const withSlot = mount(SectionHeader, {
      props: { title: "X" },
      slots: { default: "<span class='b'>badge</span>" },
    })
    expect(withSlot.find(".section-header-trailing .b").exists()).toBe(true)
  })
})

describe("Badge", () => {
  it("renders value + icon slots", () => {
    const w = mount(Badge, {
      slots: { default: "0 / 100", icon: "<i class='ic' />" },
    })
    expect(w.find(".kit-badge-value").text()).toBe("0 / 100")
    expect(w.find(".kit-badge-icon .ic").exists()).toBe(true)
  })

  it("omits the icon wrapper when no icon slot is given", () => {
    const w = mount(Badge, { slots: { default: "5" } })
    expect(w.find(".kit-badge-icon").exists()).toBe(false)
  })

  it("has no appearance props and no hardcoded colours (token-driven)", () => {
    const w = mount(Badge, { slots: { default: "5" } })
    expect(w.html()).not.toMatch(HEX)
  })
})

describe("Heatmap", () => {
  const cells: HeatmapCell[] = [
    { fill: "var(--heatmap-empty)" },
    { fill: "var(--heatmap-reviewed-2)", today: true },
    { fill: "var(--heatmap-scheduled-1)" },
  ]

  it("renders one rect per cell with the supplied fill", () => {
    const w = mount(Heatmap, { props: { cells, rows: 7 } })
    const rects = w.findAll("rect")
    expect(rects).toHaveLength(3)
    expect(rects[0].attributes("fill")).toBe("var(--heatmap-empty)")
    expect(rects[1].attributes("fill")).toBe("var(--heatmap-reviewed-2)")
  })

  it("marks today with the primary-colour stroke, others none", () => {
    const w = mount(Heatmap, { props: { cells } })
    const rects = w.findAll("rect")
    expect(rects[1].attributes("stroke")).toBe("var(--ion-color-primary)")
    expect(rects[0].attributes("stroke")).toBe("none")
  })

  it("hardcodes no hex colours (everything is token-driven)", () => {
    const w = mount(Heatmap, { props: { cells } })
    expect(w.html()).not.toMatch(HEX)
  })
})
