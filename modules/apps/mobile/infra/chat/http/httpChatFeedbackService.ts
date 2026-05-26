import type {
  FeedbackPayload,
  IChatFeedbackService,
  SubmitChatFeedbackOptions,
} from "@ports/app/index.js"
import { postFeedback, type AccessTokenProvider } from "./chatClient.js"

export interface HttpChatFeedbackServiceDeps {
  readonly getAccessToken: AccessTokenProvider
  /** Lazy resolver for the chat service base URL. See
   *  `HttpChatStreamClientDeps.baseUrl` for the rationale. */
  readonly baseUrl: () => string
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
        baseUrl: deps.baseUrl,
      })
    },
  }
}
