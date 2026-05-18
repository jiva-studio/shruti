import type {
  ChatActionPayload,
  ChatActionState,
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
  /** Hide row until user's local date reaches this `'YYYY-MM-DD'`. */
  readonly visibleOn?: string | null
  /** Unix-seconds moment to fire a LocalNotification for this message. */
  readonly notifyAt?: number | null
  /** Stamp once the LocalNotification has been registered with the OS. */
  readonly notifiedAt?: number | null
}

/**
 * Persistence boundary for chat messages. The JSON-blob columns
 * (`actions_json`, `outlines_json`, `action_states_json`) are versioned
 * via the `{ _v: 1, data }` envelope inside the SQL adapter — consumers
 * only see the discriminated-union domain types.
 */
export interface IChatMessageRepository {
  /** All messages in a session, oldest-first. */
  listBySession(sessionId: ChatSessionId): Promise<readonly ChatMessage[]>

  /** Append one message. Returns the persisted entity. */
  create(input: CreateChatMessageInput): Promise<ChatMessage>

  /** Replace the action-state map (small write). Used when the user
   *  confirms / dismisses an action card. */
  updateActionStates(
    id: ChatMessageId,
    actionStates: Record<string, ChatActionState>
  ): Promise<void>

  /** Delete every message belonging to a session. The session row is
   *  removed by the session repository; this is the cascade companion. */
  deleteBySession(sessionId: ChatSessionId): Promise<void>

  /** Wipe every message — paired with session.clearAll(). */
  clearAll(): Promise<void>
}
