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
  | {
      /** A candidate external lecture the chat found (personal library, epic
       *  #1236). Rendered as a candidate card; confirming it PRO-gates and
       *  fires the client→server call that triggers ingest of `url`. */
      readonly kind: "add_to_library"
      readonly id: string
      /** External lecture URL to ingest (YouTube link, etc.). */
      readonly url: string
      readonly title: string
      readonly author: string | null
      /** Thumbnail URL (already absolute — provider-hosted), or null. */
      readonly thumbnail: string | null
    }

export interface ChatSharePdfRefPayload {
  readonly shortName: string | null
  readonly fullName: string | null
  readonly sourceId: string | null
  readonly tokens: string | null
}

/** One shareable transcript inside a `share_pdf` action card. */
export interface ChatSharePdfItemPayload {
  readonly trackId: string
  readonly lang: string
  readonly title: string
  readonly author: string | null
  readonly date: string | null
  readonly location: string | null
  readonly references: readonly ChatSharePdfRefPayload[]
  readonly tags: readonly string[]
  /** Bucket key of the transcript; the client renders the PDF on tap. */
  readonly transcriptKey: string
}

/** Outline payload for a `[outline:<track_id>]` marker. */
export interface ChatOutlinePayload {
  readonly trackId: string
  readonly items: readonly { readonly startMs: number; readonly title: string }[]
  /** Lecture title for the card header, resolved server-side for clients with
   *  no local catalog (web). Mobile resolves it from its on-device DB. */
  readonly trackTitle?: string
}

/**
 * Media result payload for a `[media:<id>|<caption>]` marker. Streamed
 * ahead of the marker on a `media` SSE action and stashed in
 * `ChatMessage.media[id]`; `MediaCard.vue` renders the file (video/audio
 * player) plus the transcript. `url` is a RELATIVE storage path (from the
 * bucket root, e.g. `public/media/<id>.mp4`) resolved to a CDN URL at
 * render time via `storagePublicUrl`. `title` is the curated human title
 * and `text` the transcript — both rendered verbatim; `speaker` · `date`
 * form the attribution line the card shows under the title.
 */
export interface MediaPayload {
  readonly id: string
  readonly url: string
  readonly type: "video" | "audio"
  readonly title: string
  readonly speaker?: string
  readonly date?: string
  readonly text: string
  /** True when `text` is a machine translation into the answer language.
   *  `MediaCard.vue` shows a "translated automatically" footnote and lets
   *  the user toggle to `textOriginal`. Additive — absent ⇒ no badge. */
  readonly mt?: boolean
  /** The verbatim source-language transcript, present only when `mt` is
   *  true so the user can flip back to the original. */
  readonly textOriginal?: string
}

/**
 * Library verse body for a `[verse:<source>/<tokens>|caption]` marker,
 * streamed ahead of the marker on a `verse` SSE action and stashed in
 * `ChatMessage.verses["<sourceId>|<tokens>"]` so `VerseCard.vue` renders
 * the full block (sanskrit + transliteration + per-locale translation)
 * without re-fetching — and so the card still renders when the answer is
 * re-opened long after the turn. `translation` is keyed by language code;
 * the card picks the active locale (falling back to `en`).
 */
export interface ChatVerseBody {
  readonly addrLabel: string
  readonly sanskrit: string
  readonly transliteration: string
  /** Original IAST (Latin) transliteration; present only when the shown
   *  one is a different script. The card flips to it on "view original". */
  readonly transliterationOriginal?: string
  readonly translation: { readonly [lang: string]: string }
  /** Full public URL of the Sanskrit recitation, when one exists. */
  readonly audioUrl?: string
  /** True when the active-locale `translation` entry is a machine
   *  translation (card shows a footnote + a toggle to `translation.en`). */
  readonly mt?: boolean
}

/**
 * Transcript snippet for a `[cite:<track>@<start>-<end>|caption]` marker,
 * stashed in `ChatMessage.cites["<trackId>|<startMs>-<endMs>"]` so
 * `CitationCard.vue` renders the full quote without re-fetching. The
 * client holds no transcripts locally, so this is the only text source —
 * persisting it on the message keeps the card alive across reloads.
 */
export interface ChatCiteSnippet {
  readonly text: string
  /** True when `text` is a machine translation into the answer language. */
  readonly mt?: boolean
  /** Verbatim source-language transcript, present only when `mt` is true. */
  readonly textOriginal?: string
  /** Display attribution, resolved server-side in the answer language for
   *  clients that hold no local catalog (web). Mobile leaves these unset and
   *  resolves the same fields from its on-device DB. All optional so older
   *  servers / persisted messages without them still typecheck. */
  readonly trackTitle?: string
  readonly authorName?: string
  /** Lecture date, e.g. "1972-08-14". */
  readonly trackDate?: string
  /** Source references; the client renders the first `label` for now. */
  readonly references?: readonly ChatCiteReference[]
}

/** One source reference on a cite snippet. `label` is pre-formatted by the
 *  server as the client shows it (e.g. "ŚB 1.2.3") — the consumer never
 *  touches a sources dictionary. */
export interface ChatCiteReference {
  readonly sourceId: string
  readonly tokens: string | null
  readonly label: string
}

/**
 * Chapter-location region for a `[chapter:<source>/<region>|label]` marker,
 * stashed in `ChatMessage.chapters["<sourceId>|<regionToken>"]` so
 * `ChapterCard.vue` renders the chapter list. Titles are verbatim from the
 * server (`library_titles`), never composed on-device.
 */
export interface ChatChapterBody {
  readonly regionLabel: string
  readonly chapters: readonly { readonly tokens: string; readonly title: string }[]
}

/**
 * Purport / prose-chapter / letter citation for a `[commentary:<ref>]`
 * marker, stashed in `ChatMessage.commentaries["<ref>"]` so
 * `CommentaryCard.vue` renders the quote card. The `<ref>` is a per-turn
 * integer alias, so it MUST live on its own message — a global cache would
 * collide across messages that each number their commentaries from 1.
 */
export interface ChatCommentaryBody {
  readonly text: string
  readonly authorName: string
  /** Human address / reference, e.g. "БГ 2.13". */
  readonly addrLabel: string
  /** Source kind: "commentary" | "prose_chapter" | "letter". */
  readonly commentaryKind: string
  /** True when `text` is a machine translation into the answer language. */
  readonly mt?: boolean
  /** Verbatim source-language quote, present only when `mt` is true. */
  readonly textOriginal?: string
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

/**
 * Thrown by the chat HTTP adapter when the server returns 426 — the
 * mobile client's `X-Chat-Protocol-Version` header doesn't match any
 * version the server supports. Carries the server's `supported` list
 * and the value we sent so callers can render a "please update" toast
 * with a store-link CTA. Bypasses the regular SSE error event channel
 * because the failure is structural (no negotiation possible), not a
 * transient stream-level hiccup the bubble can retry on.
 */
export class ProtocolVersionMismatchError extends Error {
  readonly kind = "protocol_version_mismatch"
  constructor(
    public readonly serverSupported: number[] | undefined,
    public readonly clientSent: number | undefined,
  ) {
    super("Chat protocol version mismatch")
    this.name = "ProtocolVersionMismatchError"
  }
}

/**
 * Thrown by the chat HTTP adapter when the server returns 503 with
 * `code: "rate_limit_backend_unavailable"` — the Redis-backed rate
 * limiter is down so the server can't make a quota decision. Surfaced
 * as a typed error so the store can show a dedicated "try again in a
 * moment" toast instead of bucketing it with generic network failures.
 */
export class BackendUnavailableError extends Error {
  readonly kind = "backend_unavailable"
  constructor() {
    super("Chat backend temporarily unavailable")
    this.name = "BackendUnavailableError"
  }
}

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
  /** Media result payloads keyed by the marker's `[media:<id>]` id.
   *  Streamed ahead of the marker on a `media` SSE action; `MediaCard.vue`
   *  reads `media[token.mediaId]`. */
  media?: Record<string, MediaPayload>
  /** Verse bodies keyed `"<sourceId>|<tokens>"` — `VerseCard.vue` reads
   *  `verses[`${sourceId}|${tokens}`]`. Streamed ahead of the marker on a
   *  `verse` SSE action; persisted so the card survives a reopen. */
  verses?: Record<string, ChatVerseBody>
  /** Citation transcript snippets keyed `"<trackId>|<startMs>-<endMs>"` —
   *  `CitationCard.vue` reads its snippet here. */
  cites?: Record<string, ChatCiteSnippet>
  /** Chapter-location regions keyed `"<sourceId>|<regionToken>"` —
   *  `ChapterCard.vue` reads its region here. */
  chapters?: Record<string, ChatChapterBody>
  /** Commentary citations keyed by the `[commentary:<ref>]` ref (the
   *  per-turn integer alias as a string) — `CommentaryCard.vue` reads here. */
  commentaries?: Record<string, ChatCommentaryBody>
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
  /** The language the server settled this turn's answer in, when it settled
   *  one. Shipped back with the message on the next turn so a language the
   *  user ASKED for keeps holding — the server sees only the last 20 messages,
   *  so it cannot find the request again once it scrolls out. Assistant
   *  messages only; absent on legacy rows and on turns that settled nothing. */
  replyLanguage?: ChatReplyLanguage
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

/** The language the server settled an answer in, as persisted on the message.
 *
 *  `lang` is an OPAQUE locale code and deliberately not one of the app's
 *  interface languages: someone writing in Italian gets an Italian answer
 *  though there is no Italian UI, so it must never be validated against the
 *  language list. `requested` is true when they asked for it in words — that is
 *  what makes it outrank the language of a later message (an English quote
 *  pasted into a Russian conversation must not flip the reply back).
 *
 *  Redeclared here rather than imported from `@lib/contracts`: domain does not
 *  depend on the port layer, same as `ChatActionPayload`. */
export interface ChatReplyLanguage {
  readonly lang: string
  readonly name: string
  readonly requested: boolean
}

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
