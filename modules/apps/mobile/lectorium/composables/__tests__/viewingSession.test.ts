import { describe, expect, it } from "vitest"
import { isViewingSession } from "../viewingSession.js"

describe("isViewingSession", () => {
  it("is true on the chat route showing that session", () => {
    expect(isViewingSession({ name: "chat", query: { session: "s1" } }, "s1")).toBe(true)
  })

  it("is false on another session's thread", () => {
    expect(isViewingSession({ name: "chat", query: { session: "s2" } }, "s1")).toBe(false)
  })

  it("is false on the session list, which carries no session param", () => {
    expect(isViewingSession({ name: "chats", query: {} }, "s1")).toBe(false)
  })

  it("is false for an intent without a session", () => {
    expect(isViewingSession({ name: "chat", query: { session: "s1" } }, undefined)).toBe(false)
  })
})
