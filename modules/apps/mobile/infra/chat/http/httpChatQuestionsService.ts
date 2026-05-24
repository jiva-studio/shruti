import type {
  ChatQuestionsFocusInput,
  FetchSuggestedQuestionsOptions,
  IChatQuestionsService,
} from "@ports/app/index.js"
import { fetchSuggestedQuestions } from "./chatClient.js"

/**
 * `IChatQuestionsService` adapter over the existing
 * `fetchSuggestedQuestions` function. Same `[]`-on-failure semantics —
 * the chat store treats an empty list as "no chips to render", with no
 * toast and no retry. Mirrors the title-service adapter pattern.
 */
export function createHttpChatQuestionsService(): IChatQuestionsService {
  return {
    fetchSuggestedQuestions(
      focus: ChatQuestionsFocusInput,
      lang: "ru" | "en",
      opts?: FetchSuggestedQuestionsOptions
    ): Promise<readonly string[]> {
      return fetchSuggestedQuestions(focus, lang, opts)
    },
  }
}
