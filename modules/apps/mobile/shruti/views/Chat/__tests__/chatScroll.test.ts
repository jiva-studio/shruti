import { describe, expect, it } from "vitest"
import { findLastUserMessageId } from "../chatScroll.js"

describe("findLastUserMessageId", () => {
  it("has nothing to find in an empty list", () => {
    expect(findLastUserMessageId([])).toBeNull()
  })

  it("has nothing to find when the user has not written yet", () => {
    expect(findLastUserMessageId([{ id: "a", role: "assistant" }])).toBeNull()
  })

  it("skips the streaming placeholder above it", () => {
    const messages = [
      { id: "u1", role: "user" as const },
      { id: "a1", role: "assistant" as const },
      { id: "u2", role: "user" as const },
      { id: "a2", role: "assistant" as const },
    ]
    expect(findLastUserMessageId(messages)).toBe("u2")
  })

  it("finds the last message when it is the user's own", () => {
    const messages = [
      { id: "a1", role: "assistant" as const },
      { id: "u1", role: "user" as const },
    ]
    expect(findLastUserMessageId(messages)).toBe("u1")
  })
})
