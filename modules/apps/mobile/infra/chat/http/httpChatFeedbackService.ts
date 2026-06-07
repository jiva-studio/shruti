import type {
  FeedbackPayload,
  IChatFeedbackService,
  SubmitChatFeedbackOptions,
} from "@lib/contracts"
import { postFeedback, type AccessTokenProvider, type ChatRequest } from "./chatClient.js"

export interface HttpChatFeedbackServiceDeps {
  readonly getAccessToken: AccessTokenProvider
  /** Failover-aware HTTP client for the chat service. */
  readonly request: ChatRequest
}

/**
 * `IChatFeedbackService` adapter over the existing `postFeedback`
 * function. Same throw-on-failure semantics — callers handle revert +
 * retry on rejection.
 */
export function createHttpChatFeedbackService(
  deps: HttpChatFeedbackServiceDeps
): IChatFeedbackService {
  return {
    submitFeedback(payload: FeedbackPayload, opts?: SubmitChatFeedbackOptions): Promise<void> {
      return postFeedback(payload, {
        signal: opts?.signal,
        getAccessToken: deps.getAccessToken,
        request: deps.request,
      })
    },
  }
}
