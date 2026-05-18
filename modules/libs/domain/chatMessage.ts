import type { ChatMessageId, ChatSessionId, UnixMs } from "./core.js"

/**
 * Server-emitted "do something" payload referenced inline by an
 * `[action:<kind>|id=<id>]` marker. Each variant gets the same `id`
 * key the marker carries, so the bubble's renderer maps marker → card
 * payload by id.
 *
 * The action types track 1:1 to the chat tool side-events the agent
 * emits via `yield_event` (`actions.py`).
 */
export type ChatActionPayload =
  | {
      readonly kind: "create_playlist"
      readonly id: string
      readonly name: string
      readonly trackIds: readonly string[]
    }
  | {
      readonly kind: "save_note"
      readonly id: string
      readonly trackId: string
      readonly startMs: number
      readonly endMs: number
      readonly text: string
    }
  | {
      readonly kind: "share_pdf"
      readonly id: string
      readonly items: readonly ChatSharePdfItemPayload[]
    }

/** One downloadable PDF inside a `share_pdf` action card. */
export interface ChatSharePdfItemPayload {
  readonly trackId: string
  readonly lang: string
  readonly title: string
  readonly author: string | null
  readonly date: string | null
  readonly pdfUrl: string
}

/** Outline payload for a `[outline:<track_id>]` marker. */
export interface ChatOutlinePayload {
  readonly trackId: string
  readonly items: readonly { readonly startMs: number; readonly title: string }[]
}

/**
 * User-side state of an action card (after the LLM proposed it, the
 * UI tracks whether the user confirmed / it's executing / it landed /
 * it failed). Persisted alongside the action payload so card state
 * survives app reloads.
 *
 * The legacy `"dismissed"` value some older sessions hold collapses
 * to `"pending"` at render time — the renderer's whitelist gates this.
 */
export type ChatActionState =
  | "pending"
  | "executing"
  | "done"
  | "error"
  | "dismissed"

/**
 * Why a streamed assistant message ended without `event: done`. JSON-
 * encoded into `chat_messages.error`; the discriminator is `kind` so
 * future error shapes (rate_limited, blocked, …) can grow without a
 * schema migration. Today only `truncated` is used.
 */
export type ChatMessageError = { kind: "truncated"; reason: "stream" | "turns" }

export interface ChatMessage {
  readonly id: ChatMessageId
  readonly sessionId: ChatSessionId
  readonly role: "user" | "assistant"
  /** Raw markdown — assistant content can contain inline markers
   *  `[cite:...]`, `[card:...]`, `[action:...|id=...]`, `[outline:...]`. */
  content: string
  readonly createdAt: UnixMs
  /** Action payloads keyed by the marker's `id`. */
  actions?: Record<string, ChatActionPayload>
  /** Outline payloads keyed by `track_id`. */
  outlines?: Record<string, ChatOutlinePayload>
  /** User-confirmation state per action id. Defaults to "pending" for
   *  any id present in `actions` but not here. */
  actionStates?: Record<string, ChatActionState>
  /** Set when the message ended abnormally (see ChatMessageError). */
  error?: ChatMessageError
}
