import type { ChatSessionId, UnixMs } from "./core.js"

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
}
