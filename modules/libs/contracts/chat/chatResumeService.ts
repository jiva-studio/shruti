/**
 * Port for the resume + explicit-cancel surface (`GET` / `DELETE`
 * `/chat/turn/{trace_id}`). Mirrors the feedback/title/questions pattern:
 * thin async methods that throw on transport failure.
 *
 * Used when the app returns from background / cold start and a turn's live
 * SSE stream was dropped — the client polls the server's turn buffer by
 * the assistant message id (the adapter converts it to the hyphenless
 * 32-hex `trace_id`) and replays the buffered events.
 */

import type { ChatStreamEvent } from "./chatStreamClient.js"

export type ResumedTurnState = "running" | "done" | "error"

/**
 * A turn fetched from the server's buffer. `running` ⇒ still generating
 * (keep polling); `done` / `error` ⇒ replay `events` to rebuild the
 * message. Events arrive already parsed into the same `ChatStreamEvent`s
 * the live stream yields, so the replay folds through identical logic.
 */
export interface ResumedTurn {
  readonly state: ResumedTurnState
  readonly events: readonly ChatStreamEvent[]
}

export interface IChatResumeService {
  /** Poll a turn's buffered result by assistant message id. Resolves to
   *  null on 404 (never received / expired / not ours). Throws on other
   *  transport failures — callers retry on the next resume. */
  getTurn(messageId: string, signal?: AbortSignal): Promise<ResumedTurn | null>
  /** Explicit Stop — cancel the turn server-side (vs a passive disconnect,
   *  which lets it finish and buffer). Best-effort. */
  cancelTurn(messageId: string): Promise<void>
}
