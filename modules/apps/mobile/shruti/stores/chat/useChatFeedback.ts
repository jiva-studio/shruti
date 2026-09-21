import type { Ref } from "vue"
import type { ChatMessageId } from "@lib/domain/core.js"
import type { FeedbackCategory, IChatFeedbackService } from "@lib/contracts"
import type { IChatMessageRepository } from "@lib/domain/ports/index.js"
import { submitChatFeedback } from "@usecases"
import type { ChatMessage } from "./chatTypes.js"

export interface ChatFeedbackDeps {
  messages: Ref<ChatMessage[]>
  chatMessages: () => IChatMessageRepository
  feedbackService: () => IChatFeedbackService
}

export interface ChatFeedbackInput {
  state: "up" | "down"
  category?: FeedbackCategory
  comment?: string
}

/**
 * Persist a thumbs-up/down for an assistant message and ship it. Throws on a
 * failed POST — the UI toasts — and local state is mutated only on success, so
 * a network blip cannot desync the bubble from the server.
 *
 * Category and comment scores are written only for `down`. A later flip to
 * `up` leaves those rows behind (the backend SDK has no delete) but drops the
 * fields locally, so the bubble stays consistent.
 */
export async function submitFeedback(
  messageId: ChatMessageId,
  feedback: ChatFeedbackInput,
  deps: ChatFeedbackDeps
): Promise<void> {
  const { messages } = deps
  const msg = messages.value.find((m) => m.id === messageId)
  if (!msg || msg.role !== "assistant") {
    throw new Error("submitFeedback: assistant message not found")
  }

  const port = deps.feedbackService()
  await submitChatFeedback(
    {
      messageId,
      state: feedback.state,
      category: feedback.category,
      comment: feedback.comment,
    },
    {
      messages: deps.chatMessages(),
      post: (payload) => port.submitFeedback(payload),
    }
  )

  const idx = messages.value.findIndex((m) => m.id === messageId)
  if (idx < 0) return
  const next = [...messages.value]
  next[idx] = {
    ...next[idx],
    feedbackState: feedback.state,
    feedbackCategory: feedback.state === "down" ? feedback.category : undefined,
    feedbackComment: feedback.state === "down" ? feedback.comment : undefined,
  }
  messages.value = next
}
