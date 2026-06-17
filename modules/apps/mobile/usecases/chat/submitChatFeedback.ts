import type { ChatMessageId } from "@lib/domain/core.js"
import type { ChatFeedbackCategory } from "@lib/domain/chatMessage.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"

/**
 * Payload submitted via {@link SubmitChatFeedbackPostFn}. Mirrors the
 * shape of the IChatFeedbackService port; redefined here as a plain
 * type so this use case stays @lib/domain-only (per layers.md @ports
 * is off-limits to @usecases).
 */
export interface SubmitChatFeedbackRemotePayload {
  readonly messageId: ChatMessageId
  readonly value: "up" | "down"
  readonly category?: ChatFeedbackCategory
  readonly comment?: string
}

/**
 * Function injected by the composition root — typically
 * `IChatFeedbackService.submitFeedback` bound to the HTTP adapter.
 * Throws on transport failure; the caller (the store) handles revert.
 */
export type SubmitChatFeedbackPostFn = (payload: SubmitChatFeedbackRemotePayload) => Promise<void>

export interface SubmitChatFeedbackInput {
  readonly messageId: ChatMessageId
  readonly state: "up" | "down"
  /** Only persisted when `state === "down"` — server contract. */
  readonly category?: ChatFeedbackCategory
  /** Only persisted when `state === "down"` — server contract. */
  readonly comment?: string
}

export interface SubmitChatFeedbackDeps {
  readonly messages: IChatMessageRepository
  readonly post: SubmitChatFeedbackPostFn
}

/**
 * Persist a thumbs-up / thumbs-down on an assistant message.
 *
 * Order matters: the server-side POST is awaited FIRST. Only after it
 * succeeds do we update the local row. If the POST throws, we never
 * write locally — so a transient network failure leaves the bubble in
 * its previous state and the user can retry without de-syncing
 * client-side history vs the Langfuse trace.
 *
 * `messageId` IS the Langfuse trace id (the assistant turn shipped its
 * hyphenless 32-hex form as `X-Trace-Id` during streaming), so no
 * separate trace lookup is needed.
 */
export async function submitChatFeedback(
  input: SubmitChatFeedbackInput,
  deps: SubmitChatFeedbackDeps
): Promise<void> {
  const isDown = input.state === "down"
  await deps.post({
    messageId: input.messageId,
    value: input.state,
    category: isDown ? input.category : undefined,
    comment: isDown ? input.comment : undefined,
  })
  await deps.messages.updateFeedback(input.messageId, {
    state: input.state,
    category: isDown ? input.category : undefined,
    comment: isDown ? input.comment : undefined,
  })
}
