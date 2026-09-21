import { describe, it, expect } from "vitest"
import type { ChatMessage } from "../chatTypes.js"
import { findRetryTarget } from "../retryTarget.js"

function message(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m",
    sessionId: "s1",
    role: "user",
    content: "",
    createdAt: 0,
    ...over,
  } as ChatMessage
}

const thread: ChatMessage[] = [
  message({ id: "u1", content: "first" }),
  message({ id: "a1", role: "assistant", content: "answered" }),
  message({ id: "u2", content: "second" }),
  message({ id: "a2", role: "assistant", error: { kind: "failed", code: "stream" } }),
]

describe("findRetryTarget", () => {
  it("pairs the newest failed reply with the prompt above it", () => {
    const target = findRetryTarget(thread)

    expect(target?.assistant.id).toBe("a2")
    expect(target?.user.id).toBe("u2")
  })

  it("takes the bubble named by id, not the newest", () => {
    const withTwoFailures = [
      message({ id: "u1", content: "first" }),
      message({ id: "a1", role: "assistant", error: { kind: "truncated", reason: "stream" } }),
      ...thread.slice(2),
    ]

    expect(findRetryTarget(withTwoFailures, "a1")?.user.id).toBe("u1")
  })

  it("refuses a bubble that did not fail", () => {
    expect(findRetryTarget(thread, "a1")).toBeNull()
  })

  it("refuses a failed reply with no prompt above it", () => {
    const orphan = [
      message({ id: "a1", role: "assistant", error: { kind: "failed", code: "stream" } }),
    ]

    expect(findRetryTarget(orphan)).toBeNull()
  })

  it("is null when nothing failed", () => {
    expect(findRetryTarget(thread.slice(0, 2))).toBeNull()
  })
})
