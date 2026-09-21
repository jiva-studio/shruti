import { describe, expect, it } from "vitest"
import { ref, type Ref } from "vue"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ChatFeedbackCategory } from "@lib/domain/chatMessage.js"
import type {
  ChatFeedbackState,
  IChatMessageRepository,
} from "@lib/domain/ports/chatMessageRepository.js"
import type { FeedbackPayload, IChatFeedbackService } from "@lib/contracts"
import { submitFeedback, type ChatFeedbackDeps } from "../useChatFeedback.js"
import type { ChatMessage } from "../chatTypes.js"

function message(id: string, role: "user" | "assistant"): ChatMessage {
  return {
    id: id as ChatMessageId,
    sessionId: "s-1" as ChatSessionId,
    role,
    content: role === "user" ? "why?" : "because.",
    createdAt: 1_000,
  }
}

function unused(name: string): never {
  throw new Error(`${name} is not exercised by this test`)
}

interface Recorder {
  readonly persisted: { id: ChatMessageId; feedback: ChatFeedbackState }[]
  readonly posted: FeedbackPayload[]
}

function deps(
  messages: Ref<ChatMessage[]>,
  options: { postFails?: Error; persistFails?: Error } = {}
): ChatFeedbackDeps & { recorder: Recorder } {
  const recorder: Recorder = { persisted: [], posted: [] }

  const repository: IChatMessageRepository = {
    listBySession: () => unused("listBySession"),
    create: () => unused("create"),
    updateActionStates: () => unused("updateActionStates"),
    delete: () => unused("delete"),
    updateFollowups: () => unused("updateFollowups"),
    deleteBySession: () => unused("deleteBySession"),
    clearAll: () => unused("clearAll"),
    async updateFeedback(id, feedback) {
      if (options.persistFails) throw options.persistFails
      recorder.persisted.push({ id, feedback })
    },
  }

  const service: IChatFeedbackService = {
    async submitFeedback(payload) {
      if (options.postFails) throw options.postFails
      recorder.posted.push(payload)
    },
  }

  return {
    messages,
    chatMessages: () => repository,
    feedbackService: () => service,
    recorder,
  }
}

describe("submitFeedback", () => {
  it("persists an up vote and marks the bubble", async () => {
    const messages = ref([message("u-1", "user"), message("a-1", "assistant")])
    const d = deps(messages)

    await submitFeedback("a-1" as ChatMessageId, { state: "up" }, d)

    expect(d.recorder.posted).toEqual([
      { messageId: "a-1", value: "up", category: undefined, comment: undefined },
    ])
    expect(d.recorder.persisted).toEqual([
      { id: "a-1", feedback: { state: "up", category: undefined, comment: undefined } },
    ])
    expect(messages.value[1].feedbackState).toBe("up")
  })

  it("carries category and comment on a down vote", async () => {
    const messages = ref([message("a-1", "assistant")])
    const d = deps(messages)
    const category: ChatFeedbackCategory = "bad_citations"

    await submitFeedback(
      "a-1" as ChatMessageId,
      { state: "down", category, comment: "the verse is wrong" },
      d
    )

    expect(d.recorder.posted[0]).toEqual({
      messageId: "a-1",
      value: "down",
      category: "bad_citations",
      comment: "the verse is wrong",
    })
    expect(messages.value[0].feedbackCategory).toBe("bad_citations")
    expect(messages.value[0].feedbackComment).toBe("the verse is wrong")
  })

  it("drops category and comment when an up vote follows a down vote", async () => {
    const messages = ref([message("a-1", "assistant")])
    const d = deps(messages)

    await submitFeedback(
      "a-1" as ChatMessageId,
      { state: "down", category: "off_topic", comment: "unrelated" },
      d
    )
    await submitFeedback("a-1" as ChatMessageId, { state: "up" }, d)

    expect(messages.value[0].feedbackState).toBe("up")
    expect(messages.value[0].feedbackCategory).toBeUndefined()
    expect(messages.value[0].feedbackComment).toBeUndefined()
  })

  it("keeps an up vote free of category and comment, whatever the caller passes", async () => {
    const messages = ref([message("a-1", "assistant")])
    const d = deps(messages)

    await submitFeedback(
      "a-1" as ChatMessageId,
      { state: "up", category: "other", comment: "stale form state" },
      d
    )

    expect(d.recorder.posted[0]).toEqual({
      messageId: "a-1",
      value: "up",
      category: undefined,
      comment: undefined,
    })
    expect(messages.value[0].feedbackCategory).toBeUndefined()
    expect(messages.value[0].feedbackComment).toBeUndefined()
  })

  it("leaves the bubble untouched when the POST fails", async () => {
    const messages = ref([message("a-1", "assistant")])
    const d = deps(messages, { postFails: new Error("HTTP 503") })

    await expect(submitFeedback("a-1" as ChatMessageId, { state: "down" }, d)).rejects.toThrow(
      "HTTP 503"
    )

    expect(messages.value[0].feedbackState).toBeUndefined()
    expect(d.recorder.persisted).toEqual([])
  })

  it("leaves the bubble untouched when the local write fails", async () => {
    const messages = ref([message("a-1", "assistant")])
    const d = deps(messages, { persistFails: new Error("SQLITE_BUSY") })

    await expect(submitFeedback("a-1" as ChatMessageId, { state: "up" }, d)).rejects.toThrow(
      "SQLITE_BUSY"
    )

    expect(messages.value[0].feedbackState).toBeUndefined()
  })

  it("refuses a vote on a user message", async () => {
    const messages = ref([message("u-1", "user")])
    const d = deps(messages)

    await expect(submitFeedback("u-1" as ChatMessageId, { state: "up" }, d)).rejects.toThrow(
      "assistant message not found"
    )
    expect(d.recorder.posted).toEqual([])
  })

  it("refuses a vote on an unknown message", async () => {
    const messages = ref([message("a-1", "assistant")])
    const d = deps(messages)

    await expect(submitFeedback("ghost" as ChatMessageId, { state: "up" }, d)).rejects.toThrow(
      "assistant message not found"
    )
  })

  it("keeps a vote persisted when the thread reloaded without the message", async () => {
    const messages = ref([message("a-1", "assistant")])
    const d = deps(messages)
    const dropDuringPost: ChatFeedbackDeps = {
      ...d,
      feedbackService: () => ({
        async submitFeedback(payload) {
          messages.value = []
          await d.feedbackService().submitFeedback(payload)
        },
      }),
    }

    await submitFeedback("a-1" as ChatMessageId, { state: "up" }, dropDuringPost)

    expect(messages.value).toEqual([])
    expect(d.recorder.persisted).toHaveLength(1)
  })

  it("replaces the array rather than mutating the rendered message in place", async () => {
    const messages = ref([message("a-1", "assistant")])
    const before = messages.value
    const beforeMessage = messages.value[0]
    const d = deps(messages)

    await submitFeedback("a-1" as ChatMessageId, { state: "up" }, d)

    expect(messages.value).not.toBe(before)
    expect(beforeMessage.feedbackState).toBeUndefined()
  })
})
