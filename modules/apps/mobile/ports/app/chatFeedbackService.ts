/**
 * Port for the `/chat/feedback` endpoint. Mirrors the title/questions
 * pattern: a thin async method that throws on transport failure and
 * resolves to `void` on success. Categories and comment are only
 * meaningful when `value === "down"` per server contract.
 *
 * `FeedbackPayload.messageId` is the local `ChatMessage.id` (UUIDv4
 * with hyphens). The adapter is responsible for converting it into the
 * hyphenless 32-hex form the server uses as `trace_id`.
 */

export type FeedbackValue = "up" | "down"

export type FeedbackCategory =
  | "off_topic"
  | "no_results"
  | "bad_citations"
  | "wrong_language"
  | "factually_wrong"
  | "other"

export interface FeedbackPayload {
  readonly messageId: string
  readonly value: FeedbackValue
  readonly category?: FeedbackCategory
  readonly comment?: string
}

export interface SubmitChatFeedbackOptions {
  readonly signal?: AbortSignal
}

/**
 * Boundary for the `/chat/feedback` POST. Throws on non-2xx HTTP or
 * network failure — callers are responsible for revert + retry.
 */
export interface IChatFeedbackService {
  submitFeedback(
    payload: FeedbackPayload,
    opts?: SubmitChatFeedbackOptions
  ): Promise<void>
}
