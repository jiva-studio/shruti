import { describe, it, expect } from "vitest"
import { buildServerUrl, joinUrl } from "../cdnServer.js"

describe("buildServerUrl", () => {
  it("substitutes the {path} placeholder", () => {
    const server = { urlTemplate: "https://cdn.example.com/{path}" }
    expect(buildServerUrl(server, "a/b/c.json")).toBe("https://cdn.example.com/a/b/c.json")
  })

  it("replaces only the first {path} occurrence", () => {
    const server = { urlTemplate: "https://x/{path}?orig={path}" }
    // String.replace with a string arg replaces the first match only.
    expect(buildServerUrl(server, "k")).toBe("https://x/k?orig={path}")
  })

  it("leaves the template untouched when there is no placeholder", () => {
    const server = { urlTemplate: "https://x/fixed" }
    expect(buildServerUrl(server, "ignored")).toBe("https://x/fixed")
  })
})

describe("joinUrl", () => {
  it("returns the base unchanged for an empty path", () => {
    expect(joinUrl("https://x.com/api", "")).toBe("https://x.com/api")
  })

  it("inserts a slash when neither side has one", () => {
    expect(joinUrl("https://x.com", "config.json")).toBe("https://x.com/config.json")
  })

  it("collapses a double slash when both sides have one", () => {
    expect(joinUrl("https://x.com/", "/config.json")).toBe("https://x.com/config.json")
  })

  it("keeps the single slash when only the base has one", () => {
    expect(joinUrl("https://x.com/", "config.json")).toBe("https://x.com/config.json")
  })

  it("keeps the single slash when only the path has one", () => {
    expect(joinUrl("https://x.com", "/config.json")).toBe("https://x.com/config.json")
  })
})
