import type { ChatMessageId, ChatSessionId, TrackId, UnixMs } from "./core.js"

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
 * schema migration.
 *
 * - `truncated` — partial text was streamed before the connection
 *   dropped or the agent ran out of tool-turns. The bubble keeps the
 *   accumulated content and appends a label.
 * - `failed` — nothing usable was streamed; the assistant bubble
 *   becomes a dedicated error row with a Retry button. `code` mirrors
 *   the stream-client codes (`network`, `rate_limited`, `agent_error`,
 *   `http_<status>`, `protocol_version_required`, `stream`, …).
 *   `retryAfterAt` is an absolute UnixMs deadline (only set for
 *   `rate_limited`) — converted from the 429 `Retry-After` header at
 *   the moment the error is received, so countdowns don't drift.
 */
/** Subscription tier the rate-limit decision was made under. Echoed
 *  by the server in the 429 body so the UI can pick the right copy
 *  and CTA (anonymous → sign-in, free → buy Pro, pro → just wait). */
export type QuotaTier = "anonymous" | "free" | "pro"

export type ChatMessageError =
  | { kind: "truncated"; reason: "stream" | "turns" }
  | {
      kind: "failed"
      code: string
      retryAfterAt?: UnixMs
      /** Set only when `code === "rate_limited"` and the server returned
       *  the Phase 4 tier-aware 429 body. Absent on older servers. */
      tier?: QuotaTier
    }
  /** User tapped the stop button on the composer mid-stream. The
   *  partial assistant content is preserved (intent: they wanted to
   *  keep what they already read) and the bubble is marked so the UI
   *  can render a neutral "Stopped" label rather than the alarming
   *  "connection dropped" copy used for `truncated`. Persisted via the
   *  same `meta.error` path as the other kinds. */
  | { kind: "stopped" }

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
  /** Present iff this message was inserted by the "Ask Sadhu" flow on
   *  a transcript selection. `content` still carries the quoted text
   *  (history → LLM stays a vanilla user turn); the renderer branches
   *  on this field to draw a focus card instead of the normal bubble. */
  focus?: ChatFocusPayload
  /** Local feedback state — last value the user committed (or `null`
   *  if they haven't acted). When `down`, optional `feedbackCategory`
   *  and `feedbackComment` carry what was sent. Persisted so the
   *  thumbs UI is consistent across reloads. */
  feedbackState?: "up" | "down"
  feedbackCategory?: ChatFeedbackCategory
  feedbackComment?: string
}

/** Categories surfaced in the thumbs-down bottom-sheet. Wire format
 *  (snake_case English) — localisation lives in mobile i18n. Must stay
 *  in sync with `FeedbackCategory` enum in
 *  `services/chat/.../api/feedback.py`. */
export type ChatFeedbackCategory =
  | "off_topic"
  | "no_results"
  | "bad_citations"
  | "wrong_language"
  | "factually_wrong"
  | "other"

/** One row of the integer→chunk alias map. `startMs`/`endMs` are
 *  present only for cite-level aliases (chunks); card- and outline-
 *  level whole-track aliases leave them undefined. */
export interface ChatAliasEntry {
  readonly trackId: string
  readonly startMs?: number
  readonly endMs?: number
}

/**
 * "Focus" attached to a user-role message produced by the "Ask Sadhu"
 * flow on a transcript selection. The message's `content` carries the
 * quoted text (so it ships to the LLM as part of history like any
 * other user turn); this struct carries the bibliographic + audio
 * coordinates needed to render the message as a full-width focus
 * card (inline player + range header + quote) instead of a plain
 * user bubble.
 *
 * Multiple focus messages can accumulate inside a single session as
 * the user keeps listening and tapping Sadhu on new fragments of the
 * same track — each one is just another row in `chat_messages`.
 */
export interface ChatFocusPayload {
  readonly trackId: TrackId
  /** Selection range start in milliseconds, matches the `data-time-start`
   *  attribute on transcript blocks. */
  readonly startMs: number
  /** Selection range end in milliseconds. */
  readonly endMs: number
  /** Quoted transcript text — duplicated from the row's `content` so
   *  parsers / downstream consumers that only see `meta.focus` (e.g.
   *  the `/questions` request body) don't have to re-join with the row. */
  readonly text: string
  /** Source-audio path the inline player can hand to `shareAudioService.cut`
   *  to mint an excerpt URL. Resolved at insert time from the catalog row;
   *  cached on the message so the card can play without re-querying. */
  readonly sourceKey?: string
  /** Localised lecture title at insert time — pinned so a future
   *  catalog rename doesn't quietly change the card's header. */
  readonly trackTitle?: string
  /** Localised author name at insert time, same pinning rationale. */
  readonly authorName?: string
  /** ISO date string (`YYYY-MM-DD`) of the lecture. */
  readonly date?: string
  /** Localised location string ("Bombay", "Москва"). */
  readonly location?: string
}
