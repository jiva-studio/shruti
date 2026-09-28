import { describe, it, expect } from "vitest"
import type { ChatMessage } from "../chatThread.js"
import {
  abandonBubble,
  dropStreamingPlaceholder,
  ensureThinkingPlaceholder,
  resetBubbleForReplay,
  streamingIndex,
} from "../chatBubbles.js"

/** A thread held the way a caller holds it, so each step writes the next one back. */
function box<T>(value: T): { value: T } {
  return { value }
}

function message(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    sessionId: "s1",
    role: "assistant",
    content: "",
    createdAt: 0,
    ...over,
  } as ChatMessage
}

describe("streamingIndex", () => {
  it("is -1 when the fold holds no bubble", () => {
    const messages = box([message({ id: "m1" })])

    expect(streamingIndex(messages.value, { messageId: null })).toBe(-1)
  })

  it("finds the fold's own bubble", () => {
    const messages = box([message({ id: "m1" }), message({ id: "m2" })])

    expect(streamingIndex(messages.value, { messageId: "m2" })).toBe(1)
  })
})

describe("dropStreamingPlaceholder", () => {
  it("removes the bubble and releases the fold", () => {
    const messages = box([message({ id: "m1", streaming: true })])
    const target = { messageId: "m1" as ChatMessage["id"] }

    messages.value = dropStreamingPlaceholder(messages.value, target)

    expect(messages.value).toEqual([])
    expect(target.messageId).toBeNull()
  })

  it("leaves a settled bubble alone", () => {
    const messages = box([message({ id: "m1", content: "done" })])

    messages.value = dropStreamingPlaceholder(messages.value, {
      messageId: "m1" as ChatMessage["id"],
    })

    expect(messages.value).toHaveLength(1)
  })
})

describe("ensureThinkingPlaceholder", () => {
  it("adds one bubble and claims it for the fold", () => {
    const messages = box<ChatMessage[]>([])
    const target = { messageId: null }

    messages.value = ensureThinkingPlaceholder(messages.value, "s1", "m1", 0, target)

    expect(messages.value).toHaveLength(1)
    expect(messages.value[0].streaming).toBe(true)
    expect(target.messageId).toBe("m1")
  })

  it("claims a bubble that is already on screen without duplicating it", () => {
    const messages = box([message({ id: "m1", streaming: true })])
    const target = { messageId: null }

    messages.value = ensureThinkingPlaceholder(messages.value, "s1", "m1", 0, target)

    expect(messages.value).toHaveLength(1)
    expect(target.messageId).toBe("m1")
  })
})

describe("resetBubbleForReplay", () => {
  it("blanks the prose in place so the replay does not double it", () => {
    const messages = box([
      message({ id: "m0", role: "user", content: "q" }),
      message({
        id: "m1",
        content: "half an answer",
        error: { kind: "truncated", reason: "stream" },
      }),
    ])

    messages.value = resetBubbleForReplay(messages.value, "m1")

    expect(messages.value[1]).toMatchObject({ id: "m1", content: "", streaming: true })
    expect(messages.value[1].error).toBeUndefined()
    expect(messages.value[0].content).toBe("q")
  })
})

describe("abandonBubble", () => {
  it("fails an empty bubble", () => {
    const messages = box([message({ id: "m1", streaming: true })])
    const target = { messageId: "m1" as ChatMessage["id"] }

    messages.value = abandonBubble(messages.value, "m1", target)

    expect(messages.value[0].error).toEqual({ kind: "failed", code: "stream" })
    expect(messages.value[0].streaming).toBe(false)
    expect(target.messageId).toBeNull()
  })

  it("truncates a bubble that has prose, keeping the text", () => {
    const messages = box([message({ id: "m1", content: "partial", streaming: true })])

    messages.value = abandonBubble(messages.value, "m1")

    expect(messages.value[0]).toMatchObject({
      content: "partial",
      error: { kind: "truncated", reason: "stream" },
    })
  })

  it("ignores a bubble that is not on screen", () => {
    const messages = box([message({ id: "m1" })])

    messages.value = abandonBubble(messages.value, "gone")

    expect(messages.value).toHaveLength(1)
  })
})
