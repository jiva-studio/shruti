import type { ChatSessionId, TrackId, UnixMs } from "./core.js"

/**
 * One Sadhu-tab conversation. The `title` is initially derived locally
 * from the first user message (`deriveTitle(text)`) and replaced by an
 * LLM-generated 3-5-word rephrase via `/title` on the first assistant
 * turn. If `/title` returns null / fails, the session keeps `title`
 * null and the UI falls back to a generic header — no retry mechanism.
 *
 * `updatedAt` advances on each new message, which the History sheet
 * uses to sort sessions most-recent-first.
 */
export interface ChatSession {
  readonly id: ChatSessionId
  /** `null` until (and unless) the LLM rephrase lands. */
  readonly title: string | null
  readonly createdAt: UnixMs
  readonly updatedAt: UnixMs
  /**
   * Track this session is anchored to. Set when the session is started
   * by tapping the Sadhu icon on a transcript selection — every
   * subsequent "Ask Sadhu" from the same track lands in this session,
   * accumulating multiple focus messages. `null` for free-form chats
   * (the user opened the chat tab without a transcript context).
   */
  readonly trackId?: TrackId | null
}
