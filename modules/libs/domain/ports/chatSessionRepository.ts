import type { ChatSession } from "../chatSession.js"
import type { ChatSessionId, TrackId } from "../core.js"

export interface CreateChatSessionInput {
  readonly id: ChatSessionId
  /** Initial title — usually `deriveTitle(firstUserMessage)`. Replaced by
   *  the LLM rephrase via `/title` after the first assistant turn. */
  readonly title: string | null
  /** Optional anchor track. Set when the session is started by the
   *  "Ask Sadhu" flow from a transcript selection; left null for
   *  free-form chats started from the tab. */
  readonly trackId?: TrackId | null
}

/**
 * Persistence boundary for chat sessions. Lives in user.db. Repository
 * methods stay deliberately verb-shaped (create / updateTitle / touch /
 * delete) rather than exposing CRUD-on-fields — so consumers can't end
 * up writing untracked column updates from afar.
 */
export interface IChatSessionRepository {
  /** Whole list, most-recent-first. Used by the History sheet. */
  list(limit?: number): Promise<readonly ChatSession[]>
  getById(id: ChatSessionId): Promise<ChatSession | null>

  /** Insert a fresh session with `createdAt = updatedAt = now`. */
  create(input: CreateChatSessionInput): Promise<ChatSession>

  /** Apply the LLM rephrase. */
  updateTitle(id: ChatSessionId, title: string): Promise<void>

  /** Bump `updatedAt = now` — sorts the session to the top of the list. */
  touch(id: ChatSessionId, updatedAtMs: number): Promise<void>

  /** Hard-delete a session and all its messages (caller handles cascade
   *  via the message repo or a transaction). */
  delete(id: ChatSessionId): Promise<void>

  /** Wipe every session — used by the "Clear history" danger zone. */
  clearAll(): Promise<void>

  /** Most recent session anchored to this track, or `null` if none.
   *  Drives Sadhu-tap session reuse: a second "Ask" from the same
   *  track lands in the prior session instead of spawning a new one. */
  findLatestByTrack(trackId: TrackId): Promise<ChatSession | null>
}
