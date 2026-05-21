import type {
  ChatActionPayload,
  ChatActionState,
  ChatAliasEntry,
  ChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
} from "../chatMessage.js"
import type { ChatMessageId, ChatSessionId } from "../core.js"

export interface CreateChatMessageInput {
  readonly id: ChatMessageId
  readonly sessionId: ChatSessionId
  readonly role: "user" | "assistant"
  readonly content: string
  readonly createdAt: number
  readonly actions?: Record<string, ChatActionPayload>
  readonly outlines?: Record<string, ChatOutlinePayload>
  readonly actionStates?: Record<string, ChatActionState>
  readonly error?: ChatMessageError
  /** Ordered list of follow-up chip texts emitted by the LLM via
   *  `[followup:<text>]` markers. */
  readonly followups?: readonly string[]
  /** Integer→chunk alias map for the chip markers in `content` — see
   *  `ChatMessage.aliases`. */
  readonly aliases?: Record<string, ChatAliasEntry>
}

/**
 * Persistence boundary for chat messages. The single `meta` column on
 * `chat_messages` holds a versioned JSON envelope `{ _v: 1, data: {
 * actions, outlines, actionStates, followups, error? } }` — consumers
 * see the unpacked discriminated-union domain types via this port.
 */
export interface IChatMessageRepository {
  /** All messages in a session, oldest-first. */
  listBySession(sessionId: ChatSessionId): Promise<readonly ChatMessage[]>

  /** Append one message. Returns the persisted entity. */
  create(input: CreateChatMessageInput): Promise<ChatMessage>

  /** Replace the action-state map. Used when the user confirms /
   *  dismisses an action card; read-modify-writes the `meta` envelope. */
  updateActionStates(
    id: ChatMessageId,
    actionStates: Record<string, ChatActionState>
  ): Promise<void>

  /** Remove a single message. Used by chat retry: when the user taps
   *  Retry on a failed/truncated assistant reply, the store deletes the
   *  failed assistant row AND the user prompt that produced it so the
   *  fresh turn doesn't pile a duplicate user message into history. */
  delete(id: ChatMessageId): Promise<void>

  /** Delete every message belonging to a session. The session row is
   *  removed by the session repository; this is the cascade companion. */
  deleteBySession(sessionId: ChatSessionId): Promise<void>

  /** Wipe every message — paired with session.clearAll(). */
  clearAll(): Promise<void>
}
