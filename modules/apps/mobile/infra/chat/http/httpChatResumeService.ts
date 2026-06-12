import type { ChatStreamEvent, IChatResumeService, ResumedTurn } from "@lib/contracts"
import {
  cancelTurn,
  getTurn,
  parseStoredFrame,
  type AccessTokenProvider,
  type ChatRequest,
} from "./chatClient.js"

export interface HttpChatResumeServiceDeps {
  readonly getAccessToken: AccessTokenProvider
  /** Failover-aware HTTP client for the chat service. */
  readonly request: ChatRequest
}

/**
 * `IChatResumeService` adapter over `getTurn` / `cancelTurn` — the resume +
 * explicit-cancel surface used when the app returns from background and a
 * turn's live SSE stream was dropped. Same DI shape as the feedback service
 * (failover `request` + token provider). The wire frames are parsed into
 * typed `ChatStreamEvent`s HERE so the store stays at the port boundary.
 */
export function createHttpChatResumeService(deps: HttpChatResumeServiceDeps): IChatResumeService {
  return {
    /** Poll a turn's buffered result by assistant message id; null on 404.
     *  Events come back already parsed into typed ChatStreamEvents. */
    async getTurn(messageId: string, signal?: AbortSignal): Promise<ResumedTurn | null> {
      const buffered = await getTurn(messageId, {
        getAccessToken: deps.getAccessToken,
        request: deps.request,
        signal,
      })
      if (buffered === null) return null
      const events: ChatStreamEvent[] = []
      for (const frame of buffered.events) {
        const ev = parseStoredFrame(frame)
        if (ev) events.push(ev)
      }
      return { state: buffered.state, events }
    },
    /** Explicit Stop — cancel the turn server-side. Best-effort. */
    cancelTurn(messageId: string): Promise<void> {
      return cancelTurn(messageId, {
        getAccessToken: deps.getAccessToken,
        request: deps.request,
      })
    },
  }
}
