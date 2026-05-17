import type { ChatSessionId, UnixMs } from "./core.js"

/**
 * One Sadhu-tab conversation. The `title` is initially derived locally
 * from the first user message (`deriveTitle(text)`) and replaced by an
 * LLM-generated 3-5-word rephrase via `/title`. `titleAttemptCount`
 * bounds the foreground retry loop so a permanently broken endpoint
 * doesn't loop forever — see `TITLE_MAX_ATTEMPTS` in the chat store.
 *
 * `updatedAt` advances on each new message, which the History sheet
 * uses to sort sessions most-recent-first. `createdAt` is fixed at
 * session creation and used by the title-retry worker to cap the
 * 7-day eligibility window.
 */
export interface ChatSession {
  readonly id: ChatSessionId
  /** `null` until the LLM rephrase lands. */
  readonly title: string | null
  readonly createdAt: UnixMs
  readonly updatedAt: UnixMs
  /**
   * 0  — title generation never attempted yet.
   * 1..MAX — that many failed attempts; still retry-eligible.
   * >MAX — successful rephrase OR retry budget exhausted.
   *
   * The exact MAX lives with the retry worker, not the entity — this
   * type just records the count.
   */
  readonly titleAttemptCount: number
}
