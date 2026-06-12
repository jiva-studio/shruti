import type { ChatStreamEvent } from "@lib/contracts"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import { runChatTurn, type RunChatTurnEvent } from "./runChatTurn.js"

export interface ReplayChatTurnInput {
  /** The original assistant message id — pinned so the rebuilt reply
   *  overwrites the placeholder, and its hyphenless form is the server
   *  trace id the events were buffered under. */
  readonly assistantMessageId: ChatMessageId
  readonly sessionId: ChatSessionId
  readonly lang: string
  /** The turn's server-buffered SSE events, already parsed (from the resume
   *  adapter), in arrival order. */
  readonly events: AsyncIterable<ChatStreamEvent>
}

export interface ReplayChatTurnDeps {
  readonly messages: IChatMessageRepository
  readonly sessions: IChatSessionRepository
  readonly extractFollowups: (content: string) => readonly string[]
}

/**
 * Rebuild a chat turn from its server-buffered events when the live stream
 * was dropped (app backgrounded / killed). Delegates to `runChatTurn`'s
 * replay path — folding the buffered events through the EXACT same logic the
 * live turn uses, so there's no second parser — and needs none of the
 * live-only deps (`stream` / `title` / `buildUserContext`): the user message
 * is already persisted, there is no real stream to open, and no first-turn
 * title to fetch. Yields the same `RunChatTurnEvent`s the store reflects.
 */
export async function* replayChatTurn(
  input: ReplayChatTurnInput,
  deps: ReplayChatTurnDeps
): AsyncIterable<RunChatTurnEvent> {
  // Replaying completed events — nothing to abort.
  const neverAborts = new AbortController().signal
  yield* runChatTurn(
    {
      sessionId: input.sessionId,
      text: "",
      lang: input.lang,
      history: [],
      isFirstAssistantTurn: false,
      newMessageId: () => input.assistantMessageId,
      assistantMessageId: input.assistantMessageId,
      signal: neverAborts,
      replayEvents: input.events,
    },
    {
      messages: deps.messages,
      sessions: deps.sessions,
      extractFollowups: deps.extractFollowups,
    }
  )
}
