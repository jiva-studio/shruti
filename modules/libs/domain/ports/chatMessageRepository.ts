import type {
  ChatActionPayload,
  ChatActionState,
  ChatAliasEntry,
  ChatChapterBody,
  ChatCiteSnippet,
  ChatCommentaryBody,
  ChatFeedbackCategory,
  ChatFocusPayload,
  ChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
  ChatReplyLanguage,
  ChatVerseBody,
  MediaPayload,
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
  /** Media result payloads keyed by `[media:<id>]` id — see
   *  `ChatMessage.media`. */
  readonly media?: Record<string, MediaPayload>
  /** Verse / cite / chapter / commentary card bodies keyed as in the
   *  matching `ChatMessage` fields — persisted so the cards survive a
   *  reopen instead of degrading to chips once a global cache churns. */
  readonly verses?: Record<string, ChatVerseBody>
  readonly cites?: Record<string, ChatCiteSnippet>
  readonly chapters?: Record<string, ChatChapterBody>
  readonly commentaries?: Record<string, ChatCommentaryBody>
  readonly actionStates?: Record<string, ChatActionState>
  readonly error?: ChatMessageError
  /** Ordered list of follow-up chip texts emitted by the LLM via
   *  `[followup:<text>]` markers. */
  readonly followups?: readonly string[]
  /** Integer→chunk alias map for the chip markers in `content` — see
   *  `ChatMessage.aliases`. */
  readonly aliases?: Record<string, ChatAliasEntry>
  /** The language the server settled this answer in — see
   *  `ChatMessage.replyLanguage`. */
  readonly replyLanguage?: ChatReplyLanguage
  /** Focus payload — set when the message was inserted by the
   *  "Ask Sadhu" flow on a transcript selection. Determines whether
   *  the bubble renders as a focus card. */
  readonly focus?: ChatFocusPayload
}

/** Local feedback state persisted on an assistant message after the
 *  user taps 👍/👎. Matches the `ChatMessage` fields of the same name. */
export interface ChatFeedbackState {
  readonly state: "up" | "down"
  readonly category?: ChatFeedbackCategory
  readonly comment?: string
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

  /** Replace the followups list. Used to persist server-generated
   *  Ask-Sadhu suggestion chips onto a focus message after the
   *  `/questions` round-trip lands. Read-modify-writes the `meta`
   *  envelope so chips survive a session reload. */
  updateFollowups(id: ChatMessageId, followups: readonly string[]): Promise<void>

  /** Delete every message belonging to a session. The session row is
   *  removed by the session repository; this is the cascade companion. */
  deleteBySession(sessionId: ChatSessionId): Promise<void>

  /** Wipe every message — paired with session.clearAll(). */
  clearAll(): Promise<void>

  /** Persist the user's feedback selection (👍/👎 + optional category +
   *  comment) on an assistant message. Read-modify-writes the `meta`
   *  envelope so the thumbs UI stays consistent across reloads. The
   *  network call to `/chat/feedback` is the caller's concern — this is
   *  pure local persistence. */
  updateFeedback(id: ChatMessageId, feedback: ChatFeedbackState): Promise<void>
}
