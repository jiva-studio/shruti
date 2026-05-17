import type {
  ChatTurn,
  FetchSessionTitleOptions,
  IChatTitleService,
} from "@ports/app/index.js"
import { fetchSessionTitle } from "@lectorium/services/chatClient.js"

/**
 * `IChatTitleService` adapter over the existing `fetchSessionTitle`
 * function. Same null-on-failure semantics — the use-case treats null
 * as "keep current, bump retry counter".
 */
export function createHttpChatTitleService(): IChatTitleService {
  return {
    fetchSessionTitle(
      messages: readonly ChatTurn[],
      lang: "ru" | "en",
      opts?: FetchSessionTitleOptions
    ): Promise<string | null> {
      return fetchSessionTitle(messages, lang, opts)
    },
  }
}
