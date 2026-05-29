import type { ChatTurn, FetchSessionTitleOptions, IChatTitleService } from "@ports/app/index.js"
import { fetchSessionTitle, type AccessTokenProvider, type ChatRequest } from "./chatClient.js"

export interface HttpChatTitleServiceDeps {
  readonly getAccessToken: AccessTokenProvider
  /** Failover-aware HTTP client for the chat service. */
  readonly request: ChatRequest
}

/**
 * `IChatTitleService` adapter over the existing `fetchSessionTitle`
 * function. Same null-on-failure semantics — the use-case treats null
 * as "keep current, bump retry counter".
 */
export function createHttpChatTitleService(deps: HttpChatTitleServiceDeps): IChatTitleService {
  return {
    fetchSessionTitle(
      messages: readonly ChatTurn[],
      lang: "ru" | "en",
      opts?: FetchSessionTitleOptions
    ): Promise<string | null> {
      return fetchSessionTitle(messages, lang, {
        signal: opts?.signal,
        getAccessToken: deps.getAccessToken,
        request: deps.request,
      })
    },
  }
}
