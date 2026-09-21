import { describe, it, expect } from "vitest"
import { ref } from "vue"
import type { ChatMessage } from "../chatTypes.js"
import {
  abandonBubble,
  dropStreamingPlaceholder,
  ensureThinkingPlaceholder,
  resetBubbleForReplay,
  streamingIndex,
} from "../chatBubbles.js"

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
    const messages = ref([message({ id: "m1" })])

    expect(streamingIndex(messages, { messageId: null })).toBe(-1)
  })

  it("finds the fold's own bubble", () => {
    const messages = ref([message({ id: "m1" }), message({ id: "m2" })])

    expect(streamingIndex(messages, { messageId: "m2" })).toBe(1)
  })
})

describe("dropStreamingPlaceholder", () => {
  it("removes the bubble and releases the fold", () => {
    const messages = ref([message({ id: "m1", streaming: true })])
    const target = { messageId: "m1" as ChatMessage["id"] }

    dropStreamingPlaceholder(messages, target)

    expect(messages.value).toEqual([])
    expect(target.messageId).toBeNull()
  })

  it("leaves a settled bubble alone", () => {
    const messages = ref([message({ id: "m1", content: "done" })])

    dropStreamingPlaceholder(messages, { messageId: "m1" as ChatMessage["id"] })

    expect(messages.value).toHaveLength(1)
  })
})

describe("ensureThinkingPlaceholder", () => {
  it("adds one bubble and claims it for the fold", () => {
    const messages = ref<ChatMessage[]>([])
    const target = { messageId: null }

    ensureThinkingPlaceholder(messages, "s1", "m1", target)

    expect(messages.value).toHaveLength(1)
    expect(messages.value[0].streaming).toBe(true)
    expect(target.messageId).toBe("m1")
  })

  it("claims a bubble that is already on screen without duplicating it", () => {
    const messages = ref([message({ id: "m1", streaming: true })])
    const target = { messageId: null }

    ensureThinkingPlaceholder(messages, "s1", "m1", target)

    expect(messages.value).toHaveLength(1)
    expect(target.messageId).toBe("m1")
  })
})

describe("resetBubbleForReplay", () => {
  it("blanks the prose in place so the replay does not double it", () => {
    const messages = ref([
      message({ id: "m0", role: "user", content: "q" }),
      message({
        id: "m1",
        content: "half an answer",
        error: { kind: "truncated", reason: "stream" },
      }),
    ])

    resetBubbleForReplay(messages, "m1")

    expect(messages.value[1]).toMatchObject({ id: "m1", content: "", streaming: true })
    expect(messages.value[1].error).toBeUndefined()
    expect(messages.value[0].content).toBe("q")
  })
})

describe("abandonBubble", () => {
  it("fails an empty bubble", () => {
    const messages = ref([message({ id: "m1", streaming: true })])
    const target = { messageId: "m1" as ChatMessage["id"] }

    abandonBubble(messages, "m1", target)

    expect(messages.value[0].error).toEqual({ kind: "failed", code: "stream" })
    expect(messages.value[0].streaming).toBe(false)
    expect(target.messageId).toBeNull()
  })

  it("truncates a bubble that has prose, keeping the text", () => {
    const messages = ref([message({ id: "m1", content: "partial", streaming: true })])

    abandonBubble(messages, "m1")

    expect(messages.value[0]).toMatchObject({
      content: "partial",
      error: { kind: "truncated", reason: "stream" },
    })
  })

  it("ignores a bubble that is not on screen", () => {
    const messages = ref([message({ id: "m1" })])

    abandonBubble(messages, "gone")

    expect(messages.value).toHaveLength(1)
  })
})
