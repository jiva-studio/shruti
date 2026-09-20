import { describe, it, expect } from "vitest"
import { mount } from "@vue/test-utils"
import { AppLoading } from "../index.js"

describe("AppLoading", () => {
  it("renders the app name and status", () => {
    const w = mount(AppLoading, {
      props: { appName: "Lectorium", status: "Downloading content…" },
    })
    expect(w.find(".kit-app-loading-name").text()).toBe("Lectorium")
    expect(w.find(".kit-app-loading-message").text()).toBe("Downloading content…")
  })

  it("renders the icon from iconSrc", () => {
    const w = mount(AppLoading, {
      props: { appName: "X", status: "…", iconSrc: "/app-icon.png" },
    })
    expect(w.find("img.kit-app-loading-logo").attributes("src")).toBe("/app-icon.png")
  })

  it("prefers the icon slot over iconSrc", () => {
    const w = mount(AppLoading, {
      props: { appName: "X", status: "…", iconSrc: "/app-icon.png" },
      slots: { icon: "<div class='custom-icon' />" },
    })
    expect(w.find(".custom-icon").exists()).toBe(true)
    expect(w.find("img.kit-app-loading-logo").exists()).toBe(false)
  })

  it("shows a determinate bar (0–1 value) when progress is set", () => {
    const determinate = mount(AppLoading, {
      props: { appName: "X", status: "…", progress: 0.4 },
    })
    const bar = determinate.findComponent({ name: "IonProgressBar" })
    expect(bar.exists()).toBe(true)
    expect(bar.props("type")).toBe("determinate")
    expect(bar.props("value")).toBe(0.4)
  })

  it("shows an indeterminate bar when progress is omitted", () => {
    const indeterminate = mount(AppLoading, { props: { appName: "X", status: "…" } })
    const bar = indeterminate.findComponent({ name: "IonProgressBar" })
    expect(bar.exists()).toBe(true)
    expect(bar.props("type")).toBe("indeterminate")
  })

  it("treats progress 0 as indeterminate (animated, visible — not an empty bar)", () => {
    const bar = mount(AppLoading, {
      props: { appName: "X", status: "…", progress: 0 },
    }).findComponent({ name: "IonProgressBar" })
    expect(bar.props("type")).toBe("indeterminate")
  })

  it("is determinate once progress is positive", () => {
    const bar = mount(AppLoading, {
      props: { appName: "X", status: "…", progress: 0.4 },
    }).findComponent({ name: "IonProgressBar" })
    expect(bar.props("type")).toBe("determinate")
    expect(bar.props("value")).toBe(0.4)
  })

  it("clamps out-of-range progress into 0–1", () => {
    const over = mount(AppLoading, {
      props: { appName: "X", status: "…", progress: 1.5 },
    }).findComponent({ name: "IonProgressBar" })
    expect(over.props("value")).toBe(1)

    const under = mount(AppLoading, {
      props: { appName: "X", status: "…", progress: -0.2 },
    }).findComponent({ name: "IonProgressBar" })
    expect(under.props("value")).toBe(0)
  })

  it("always renders a progress bar in the non-error state", () => {
    const w = mount(AppLoading, { props: { appName: "X", status: "Checking…" } })
    expect(w.findComponent({ name: "IonProgressBar" }).exists()).toBe(true)
  })

  it("hides the progress bar in the error state", () => {
    const w = mount(AppLoading, {
      props: { appName: "X", status: "…", errorText: "boom" },
    })
    expect(w.findComponent({ name: "IonProgressBar" }).exists()).toBe(false)
  })

  it("shows the error + retry button and emits retry on click", async () => {
    const w = mount(AppLoading, {
      props: { appName: "X", status: "…", errorText: "boom", retryLabel: "Try again" },
    })
    expect(w.find(".kit-app-loading-message").text()).toBe("boom")
    const button = w.findComponent({ name: "IonButton" })
    expect(button.text()).toBe("Try again")
    await button.trigger("click")
    expect(w.emitted("retry")).toHaveLength(1)
  })

  it("hides the retry button when there is no error", () => {
    const w = mount(AppLoading, { props: { appName: "X", status: "…" } })
    expect(w.findComponent({ name: "IonButton" }).exists()).toBe(false)
  })
})
