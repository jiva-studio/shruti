import { describe, expect, it } from "vitest"
import { buildDiagnosticsBody, mailtoUrl, tailLogs } from "../diagnosticsEmail.js"

const facts = {
  userId: "u-1",
  email: null,
  tier: "free",
  isPro: false,
  appUserId: null,
  deviceId: "d-1",
  platform: "android",
  appVersion: "1.3.3 (2015)",
  locale: "ru",
}

describe("tailLogs", () => {
  it("leaves a short log untouched", () => {
    expect(tailLogs("abc", 10)).toBe("abc")
  })

  it("keeps the end of a long log", () => {
    expect(tailLogs("abcdef", 3)).toBe("def")
  })
})

describe("buildDiagnosticsBody", () => {
  it("prints an em dash for every unknown field", () => {
    const body = buildDiagnosticsBody("hello", facts, "")
    expect(body).toContain("Email: —")
    expect(body).toContain("RevenueCat App User ID: —")
  })

  it("marks a pro tier", () => {
    expect(buildDiagnosticsBody("hello", { ...facts, isPro: true }, "")).toContain(
      "Tier: free (pro)"
    )
  })

  it("appends the log tail under its own heading", () => {
    expect(buildDiagnosticsBody("hello", facts, "line")).toMatch(/— logs —\nline$/)
  })
})

describe("mailtoUrl", () => {
  it("escapes the subject and the body", () => {
    expect(mailtoUrl("a@b.c", "a b", "c&d")).toBe("mailto:a@b.c?subject=a%20b&body=c%26d")
  })
})
