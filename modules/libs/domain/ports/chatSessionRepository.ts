import type { ChatSession } from "../chatSession.js"
import type { ChatSessionId } from "../core.js"

export interface CreateChatSessionInput {
  readonly id: ChatSessionId
  /** Initial title — usually `deriveTitle(firstUserMessage)`. Replaced by
   *  the LLM rephrase via `/title` after the first round-trip. */
  readonly title: string | null
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

  /** Insert a fresh session with `createdAt = updatedAt = now`,
   *  `titleAttemptCount = 0`. */
  create(input: CreateChatSessionInput): Promise<ChatSession>

  /** Apply the LLM rephrase. Also bumps `titleAttemptCount` to the
   *  "success" sentinel so the foreground retry worker stops trying. */
  updateTitle(id: ChatSessionId, title: string): Promise<void>

  /** Bump `updatedAt = now` — sorts the session to the top of the list. */
  touch(id: ChatSessionId, updatedAtMs: number): Promise<void>

  /** Increment the failed-attempt counter. */
  incrementTitleAttempt(id: ChatSessionId): Promise<void>

  /** Hard-delete a session and all its messages (caller handles cascade
   *  via the message repo or a transaction). */
  delete(id: ChatSessionId): Promise<void>

  /** Wipe every session — used by the "Clear history" danger zone. */
  clearAll(): Promise<void>
}
