import type {
  ChatQuestionsFocusInput,
  FetchSuggestedQuestionsOptions,
  IChatQuestionsService,
} from "@lib/contracts"
import {
  fetchSuggestedQuestions,
  type AccessTokenProvider,
  type ChatRequest,
} from "./chatClient.js"

export interface HttpChatQuestionsServiceDeps {
  readonly getAccessToken: AccessTokenProvider
  /** Failover-aware HTTP client for the chat service. */
  readonly request: ChatRequest
}

/**
 * `IChatQuestionsService` adapter over the existing
 * `fetchSuggestedQuestions` function. Same `[]`-on-failure semantics —
 * the chat store treats an empty list as "no chips to render", with no
 * toast and no retry. Mirrors the title-service adapter pattern.
 */
export function createHttpChatQuestionsService(
  deps: HttpChatQuestionsServiceDeps
): IChatQuestionsService {
  return {
    fetchSuggestedQuestions(
      focus: ChatQuestionsFocusInput,
      lang: "ru" | "en",
      opts?: FetchSuggestedQuestionsOptions
    ): Promise<readonly string[]> {
      return fetchSuggestedQuestions(focus, lang, {
        signal: opts?.signal,
        getAccessToken: deps.getAccessToken,
        request: deps.request,
      })
    },
  }
}
