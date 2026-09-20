import { describe, it, expect } from "vitest"
import { mount } from "@vue/test-utils"
import { BuildInfo } from "../index.js"

const HEX = /#[0-9a-fA-F]{3,8}\b/

describe("BuildInfo", () => {
  it("renders version + buildId from props", () => {
    const w = mount(BuildInfo, { props: { version: "1.4.0", buildId: "1234" } })
    expect(w.find(".kit-build-info-version").text()).toBe("v1.4.0 (1234)")
  })

  it("appends build time when provided", () => {
    const w = mount(BuildInfo, {
      props: { version: "1.0.0", buildId: "9", buildTime: "2026-06-06" },
    })
    expect(w.find(".kit-build-info-version").text()).toBe("v1.0.0 (9) · 2026-06-06")
  })

  it("shows DB number/scheme only when supplied", () => {
    const without = mount(BuildInfo, { props: { version: "1", buildId: "1" } })
    expect(without.find(".kit-build-info-db").exists()).toBe(false)

    const withDb = mount(BuildInfo, {
      props: { version: "1", buildId: "1", dbNumber: "42", dbScheme: 7 },
    })
    expect(withDb.find(".kit-build-info-db").text()).toBe("DB 42 · scheme 7")
  })

  it("renders supplied debug ids and hides them otherwise", () => {
    const without = mount(BuildInfo, { props: { version: "1", buildId: "1" } })
    expect(without.find(".kit-build-info-id").exists()).toBe(false)

    const withIds = mount(BuildInfo, {
      props: {
        version: "1",
        buildId: "1",
        debugIds: [
          { label: "uid", value: "abc" },
          { label: "rc", value: "def" },
        ],
      },
    })
    const ids = withIds.findAll(".kit-build-info-id")
    expect(ids).toHaveLength(2)
    expect(ids[0].text()).toBe("uid abc")
    expect(ids[1].text()).toBe("rc def")
  })

  it("emits tap on click", async () => {
    const w = mount(BuildInfo, { props: { version: "1", buildId: "1" } })
    await w.find(".kit-build-info").trigger("click")
    expect(w.emitted("tap")).toHaveLength(1)
  })

  it("hardcodes no hex colours (token-driven)", () => {
    const w = mount(BuildInfo, {
      props: { version: "1", buildId: "1", dbNumber: "1", dbScheme: 1 },
    })
    expect(w.html()).not.toMatch(HEX)
  })
})
