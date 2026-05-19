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
/** Subset of `useAutoDownloadFiltersStore`'s shape used by the
 *  `configure_smart_library` action card. Open list of filter ids the
 *  user can drop into the auto-download settings with one tap. */
export interface SmartLibraryFiltersPayload {
  readonly authorIds?: readonly string[]
  readonly tagIds?: readonly string[]
  readonly sourceIds?: readonly string[]
  readonly locationIds?: readonly string[]
  readonly languageCodes?: readonly string[]
}

export type ChatActionPayload =
  | {
      readonly kind: "create_playlist"
      readonly id: string
      readonly name: string
      readonly trackIds: readonly string[]
    }
  | {
      readonly kind: "share_pdf"
      readonly id: string
      readonly items: readonly ChatSharePdfItemPayload[]
    }
  | {
      readonly kind: "enable_daily_reminder"
      readonly id: string
      /** `'HH:mm'` 24h local time the reminder should fire at. */
      readonly time: string
    }
  | {
      readonly kind: "configure_smart_library"
      readonly id: string
      readonly filters: SmartLibraryFiltersPayload
    }
  | {
      readonly kind: "upgrade_to_pro"
      readonly id: string
      /** Short tag explaining why the upsell card surfaced (e.g.
       *  "smart_library", "weekly_digest"). Plumbed into the paywall
       *  analytics context. */
      readonly reason: string
    }
  | {
      readonly kind: "queue_next_track"
      readonly id: string
      readonly trackId: string
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
   *  `[cite:...]`, `[card:...]`, `[action:...|id=...]`, `[outline:...]`,
   *  `[followup:<text>]`. */
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
  /** Tappable follow-up chips the assistant emitted via
   *  `[followup:<text>]` markers at the end of `content`. Each entry
   *  is the literal chip text; tapping sends it verbatim as the next
   *  user message. Capped at 3 by the parser. Rendered only under the
   *  last assistant message of the session. */
  followups?: readonly string[]
  /** Server-minted integer→chunk alias map for the chip markers in
   *  this message's `content`. We round-trip it to the server on the
   *  next turn so the LLM sees the prior assistant content in
   *  `[cite:N|caption]` numbered-ref form instead of the expanded
   *  `[cite:track_X@start-end|caption]` (which conflicts with the
   *  numbered-ref system prompt and makes weak models stop citing).
   *  Keys are integer aliases serialised as strings (JSON limitation);
   *  values describe each catalog reference. Absent on legacy
   *  messages; the server falls back to placeholder-stripping for
   *  those. */
  aliases?: Record<string, ChatAliasEntry>
}

/** One row of the integer→chunk alias map. `startMs`/`endMs` are
 *  present only for cite-level aliases (chunks); card- and outline-
 *  level whole-track aliases leave them undefined. */
export interface ChatAliasEntry {
  readonly trackId: string
  readonly startMs?: number
  readonly endMs?: number
}
