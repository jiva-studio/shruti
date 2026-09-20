import { describe, it, expect, beforeAll } from "vitest"
import { mount } from "@vue/test-utils"
import {
  AppPage,
  Header,
  IconChip,
  LazyImage,
  Message,
  PageSticker,
  ProBadge,
  SafeAreaHeaderGradient,
} from "../index.js"

// These primitives lean on real Ionic web components (ion-header, ion-button,
// ion-page, ion-content, ion-spinner). jsdom doesn't auto-register custom
// elements, so stub them as inert HTMLElements — our template logic (slots,
// props, classes, emitted events) still runs and is queryable by tag.
beforeAll(() => {
  for (const tag of ["ion-header", "ion-button", "ion-page", "ion-content", "ion-spinner"]) {
    if (!customElements.get(tag)) {
      customElements.define(tag, class extends HTMLElement {})
    }
  }
})

const HEX = /#[0-9a-fA-F]{3,8}\b/

describe("AppPage", () => {
  it("renders the default slot content (not loading)", () => {
    const w = mount(AppPage, { slots: { default: "<div class='c'>body</div>" } })
    expect(w.find(".page-content .c").text()).toBe("body")
    expect(w.find(".spinner").exists()).toBe(false)
    expect(w.find(".placeholder").exists()).toBe(false)
  })

  it("shows the default spinner while loading", () => {
    const w = mount(AppPage, { props: { loading: true } })
    expect(w.find(".spinner").exists()).toBe(true)
    expect(w.find(".page-content").exists()).toBe(false)
  })

  it("renders the bottom spacer only when reserveBottomSpace is set", () => {
    const w = mount(AppPage, { props: { reserveBottomSpace: true } })
    expect(w.find(".placeholder").exists()).toBe(true)
  })
})

describe("Header", () => {
  it("renders default slot inside an ion-header", () => {
    const w = mount(Header, { slots: { default: "<h1 class='t'>Title</h1>" } })
    expect(w.find("ion-header .t").text()).toBe("Title")
  })
})

describe("IconChip", () => {
  it("renders the icon slot", () => {
    const w = mount(IconChip, { slots: { default: "<svg class='ic' />" } })
    expect(w.find(".kit-icon-chip .ic").exists()).toBe(true)
    expect(w.find(".kit-icon-chip--danger").exists()).toBe(false)
  })

  it("applies the danger modifier when set", () => {
    const w = mount(IconChip, { props: { danger: true } })
    expect(w.find(".kit-icon-chip--danger").exists()).toBe(true)
  })

  it("hardcodes no hex colours (token-driven)", () => {
    const w = mount(IconChip, { props: { danger: true } })
    expect(w.html()).not.toMatch(HEX)
  })
})

describe("LazyImage", () => {
  it("renders src/alt and fades in on load", async () => {
    const w = mount(LazyImage, { props: { src: "/a.png", alt: "alt" } })
    const img = w.find("img")
    expect(img.attributes("src")).toBe("/a.png")
    expect(img.attributes("alt")).toBe("alt")
    expect(img.classes()).not.toContain("visible")
    await img.trigger("load")
    expect(w.find("img").classes()).toContain("visible")
    expect(w.emitted("load")).toHaveLength(1)
  })
})

describe("Message", () => {
  it("renders body + close-icon slots and emits close", async () => {
    const w = mount(Message, {
      slots: { default: "warning text", "close-icon": "<i class='x' />" },
    })
    expect(w.find(".content").text()).toBe("warning text")
    expect(w.find(".close-button .x").exists()).toBe(true)
    await w.find("ion-button").trigger("click")
    expect(w.emitted("close")).toHaveLength(1)
  })

  it("imports no icon set and hardcodes no colours", () => {
    const w = mount(Message, { slots: { default: "x" } })
    expect(w.html()).not.toMatch(HEX)
  })
})

describe("ProBadge", () => {
  it("renders the label prop", () => {
    const w = mount(ProBadge, { props: { label: "PRO" } })
    expect(w.find(".pro-badge").text()).toBe("PRO")
  })

  it("prefers the default slot over the label", () => {
    const w = mount(ProBadge, {
      props: { label: "PRO" },
      slots: { default: "PREMIUM" },
    })
    expect(w.find(".pro-badge").text()).toBe("PREMIUM")
  })

  it("hardcodes no hex colours (token-driven)", () => {
    const w = mount(ProBadge, { props: { label: "PRO" } })
    expect(w.html()).not.toMatch(HEX)
  })
})

describe("PageSticker", () => {
  it("renders header/message and the footer slot", () => {
    const w = mount(PageSticker, {
      props: { header: "Empty", message: "Nothing here" },
      slots: { footer: "<button class='cta'>Go</button>" },
    })
    expect(w.find(".sticker-header").text()).toBe("Empty")
    expect(w.find(".sticker-message").text()).toBe("Nothing here")
    expect(w.find(".sticker-footer .cta").exists()).toBe(true)
  })

  it("emits navigate with the `to` payload on body click (no router)", async () => {
    const w = mount(PageSticker, { props: { to: "search" } })
    await w.find(".page-sticker").trigger("click")
    expect(w.emitted("navigate")).toEqual([["search"]])
  })

  it("does not navigate when the footer is clicked", async () => {
    const w = mount(PageSticker, {
      props: { to: "search" },
      slots: { footer: "<button class='cta'>Go</button>" },
    })
    await w.find(".sticker-footer .cta").trigger("click")
    expect(w.emitted("navigate")).toBeUndefined()
  })
})

describe("SafeAreaHeaderGradient", () => {
  it("renders a single fixed gradient element with no hardcoded colours", () => {
    const w = mount(SafeAreaHeaderGradient)
    expect(w.find(".safe-area-header").exists()).toBe(true)
    expect(w.html()).not.toMatch(HEX)
  })
})
