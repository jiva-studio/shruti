import type {
  FeedbackPayload,
  IChatFeedbackService,
  SubmitChatFeedbackOptions,
} from "@ports/app/index.js"
import { postFeedback } from "./chatClient.js"

/**
 * `IChatFeedbackService` adapter over the existing `postFeedback`
 * function. Same throw-on-failure semantics — callers handle revert +
 * retry on rejection.
 */
export function createHttpChatFeedbackService(): IChatFeedbackService {
  return {
    submitFeedback(payload: FeedbackPayload, opts?: SubmitChatFeedbackOptions): Promise<void> {
      return postFeedback(payload, { signal: opts?.signal })
    },
  }
}
