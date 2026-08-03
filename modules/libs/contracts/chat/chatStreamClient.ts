/**
 * Wire payloads emitted by the chat agent as SSE side-events. These
 * types are duplicated (intentionally) on the domain side as
 * `ChatActionPayload` / `ChatOutlinePayload` on `ChatMessage`. Ports
 * must not import `@lib/domain` (clean-architecture rule), and domain
 * must not import ports either — both layers redeclare the wire
 * contract independently and the composition root reconciles them.
 *
 * v1 SSE protocol: `kind`-specific fields live under nested `payload`
 * — the discriminator (kind, id) is split from the body so a single
 * switch on `kind` routes to the right payload reader.
 */
export type ChatActionPayload =
  | {
      readonly kind: "share_pdf"
      readonly id: string
      readonly payload: { readonly items: readonly ChatSharePdfItemPayload[] }
    }
  | {
      readonly kind: "add_to_library"
      readonly id: string
      readonly payload: {
        readonly url: string
        readonly title: string
        readonly author: string | null
        readonly thumbnail: string | null
      }
    }
  | {
      readonly kind: "enable_daily_reminder"
      readonly id: string
      readonly payload: { readonly time: string }
    }
  | {
      readonly kind: "configure_smart_library"
      readonly id: string
      readonly payload: {
        readonly filters: {
          readonly authorIds?: readonly string[]
          readonly tagIds?: readonly string[]
          readonly sourceIds?: readonly string[]
          readonly locationIds?: readonly string[]
          readonly languageCodes?: readonly string[]
        }
      }
    }
  | {
      readonly kind: "upgrade_to_pro"
      readonly id: string
      readonly payload: { readonly reason: string }
    }
  | {
      readonly kind: "outline"
      readonly id: string
      readonly payload: ChatOutlinePayload
    }
  | {
      readonly kind: "verse"
      readonly id: string
      readonly payload: ChatVersePayloadWire
    }
  | {
      readonly kind: "cite_transcript"
      readonly id: string
      readonly payload: ChatCiteTranscriptPayloadWire
    }
  | {
      readonly kind: "chapter"
      readonly id: string
      readonly payload: ChatChapterPayloadWire
    }
  | {
      readonly kind: "media"
      readonly id: string
      readonly payload: ChatMediaPayloadWire
    }
  | {
      readonly kind: "commentary"
      readonly id: string
      readonly payload: ChatCommentaryPayloadWire
    }

export interface ChatSharePdfRefPayload {
  readonly shortName: string | null
  readonly fullName: string | null
  readonly sourceId: string | null
  readonly tokens: string | null
}

export interface ChatSharePdfItemPayload {
  readonly trackId: string
  readonly lang: string
  readonly title: string
  readonly author: string | null
  readonly date: string | null
  readonly location: string | null
  readonly references: readonly ChatSharePdfRefPayload[]
  readonly tags: readonly string[]
  /** Bucket key of the transcript to render. The client renders the PDF
   *  on tap via share-transcript — no pre-rendered URL on the wire. */
  readonly transcriptKey: string
}

export interface ChatOutlinePayload {
  readonly trackId: string
  readonly items: readonly { readonly startMs: number; readonly title: string }[]
}

/** Verse body shipped ahead of the prose deltas containing the
 *  `[verse:source_id/tokens|caption]` marker that references it.
 *  The store subscriber caches it under `${sourceId}|${tokens}` so
 *  VerseCard renders the full block instead of the chip placeholder.
 *
 *  Wire fields are snake_case to match the agent's emitted JSON; the
 *  use-case layer maps them to camelCase on the domain side. */
export interface ChatVersePayloadWire {
  readonly source_id: string
  readonly tokens: string
  readonly addr_label: string
  readonly sanskrit: string
  readonly transliteration: string
  /** Original IAST (Latin) transliteration, present only when the shown
   *  `transliteration` is a different script. Lets the card flip the
   *  transliteration with the translation on "view original". Additive. */
  readonly transliteration_original?: string
  readonly translation: Readonly<Record<string, string>>
  /** Full public URL of the Sanskrit recitation for this verse, present
   *  only when the library has audio for it. Server expands the stored
   *  S3 key into an absolute URL; absent ⇒ no audio button. */
  readonly audio_url?: string
  /** True when `translation[lang]` is a machine translation (no native
   *  text existed). The card surfaces a "translated automatically"
   *  footnote and lets the user toggle to the original `translation.en`.
   *  Additive — old servers omit it; absence ⇒ no badge. */
  readonly mt?: boolean
}

/** Transcript snippet shipped ahead of the prose deltas containing the
 *  `[cite:track@start-end|caption]` marker that references it. The store
 *  subscriber caches it under `${track_id}|${start_ms}-${end_ms}` so
 *  CitationCard renders the full quote block instead of the chip
 *  placeholder. Wire fields are snake_case to match the agent's JSON. */
export interface ChatCiteTranscriptPayloadWire {
  readonly track_id: string
  readonly start_ms: number
  readonly end_ms: number
  readonly text: string
  /** True when `text` is a machine translation into the answer language.
   *  The card shows a "translated automatically" footnote with a toggle
   *  to `text_original`. Additive — absent ⇒ no badge. */
  readonly mt?: boolean
  /** The verbatim source-language transcript, present only when `mt` is
   *  true so the user can flip back to the original. */
  readonly text_original?: string
}

/** A purport / prose-chapter / letter citation shipped ahead of the prose
 *  delta carrying its `[commentary:<ref>]` marker (the audio-citation
 *  shape, for clients that declared the `commentary_card` capability). The
 *  store caches it under `ref` so `CommentaryCard.vue` renders the quote as
 *  a card (text + author + reference) like the audio card, instead of an
 *  inline blockquote. `ref` matches the integer in the marker. */
export interface ChatCommentaryPayloadWire {
  /** Integer citation ref — equals N in the `[commentary:N]` marker. */
  readonly ref: number
  /** Joined cited sentences in the answer language (shown text). */
  readonly text: string
  readonly author_name: string
  /** Human address / reference, e.g. "БГ 2.13". */
  readonly addr_label: string
  /** Source kind: "commentary" | "prose_chapter" | "letter". */
  readonly kind: string
  /** True when `text` is a machine translation into the answer language.
   *  The card shows a "translated automatically" footnote with a toggle to
   *  `text_original`. Additive — absent ⇒ no badge. */
  readonly mt?: boolean
  /** The verbatim source-language quote, present only when `mt` is true so
   *  the user can flip back to the original. */
  readonly text_original?: string
}

/** Chapter-location region shipped ahead of the prose deltas containing
 *  the `[chapter:source_id/region_token|label]` marker (locate intent).
 *  The store subscriber caches it under `${source_id}|${region_token}` so
 *  ChapterCard renders the canto/chapter list instead of the chip.
 *  Snake_case to match the agent's emitted JSON. */
export interface ChatChapterPayloadWire {
  readonly source_id: string
  readonly region_token: string
  readonly region_label: string
  readonly chapters: readonly { readonly tokens: string; readonly title: string }[]
}

/** Media result (video / audio file + transcript) shipped ahead of the
 *  prose deltas containing the `[media:<id>|<caption>]` marker that
 *  references it. The store subscriber stashes it on
 *  `ChatMessage.media[id]` so `MediaCard.vue` renders the player + the
 *  transcript. `url` is a RELATIVE storage path (from the bucket root);
 *  the renderer resolves it to a CDN URL. `title` is the server-built
 *  label and `text` the transcript — both rendered verbatim. Wire fields
 *  are flat (no snake_case translation needed; ids/strings only). */
export interface ChatMediaPayloadWire {
  readonly id: string
  readonly url: string
  readonly type: "video" | "audio"
  readonly title: string
  readonly speaker?: string
  readonly text: string
  /** True when `text` is a machine translation into the answer language.
   *  The card shows a "translated automatically" footnote with a toggle
   *  to `text_original`. Additive — absent ⇒ no badge. */
  readonly mt?: boolean
  /** The verbatim source-language transcript, present only when `mt` is
   *  true so the user can flip back to the original. */
  readonly text_original?: string
}

export type ChatRole = "user" | "assistant"

/** The language the server settled a turn's answer in.
 *
 *  Round-tripped: it arrives on `done`, the client stores it on the assistant
 *  message and ships it back on the next turn. That is what makes «отвечай
 *  по-русски» hold for the rest of the dialogue — the server caps history at
 *  20 messages, so re-deriving the request from the conversation stops working
 *  once it scrolls out (and after an app restart, which drops it entirely).
 *
 *  `lang` is an opaque locale code — NOT one of the app's languages. Someone
 *  writing in Italian gets an Italian answer even though there is no Italian
 *  UI, so never validate it against the interface-language list. `requested`
 *  is true when the person asked for the language in words, which is what lets
 *  it outrank the language a later message happens to be written in. */
export interface ChatReplyLanguage {
  readonly lang: string
  readonly name: string
  readonly requested: boolean
}

export interface ChatTurn {
  readonly role: ChatRole
  readonly content: string
  /** What a previous turn settled the answer language to be. Only on
   *  `role === "assistant"`; the wire layer sends it as `reply_language`. */
  readonly replyLanguage?: ChatReplyLanguage
  /** Server-minted integer→chunk alias map for the chip markers in
   *  this assistant message's `content`. Round-tripped from a prior
   *  turn's `aliases` SSE event via the client's meta storage. Only
   *  present on `role === "assistant"`. Wire layer maps it back to
   *  snake_case before sending. */
  readonly aliases?: Readonly<
    Record<string, { readonly trackId: string; readonly startMs?: number; readonly endMs?: number }>
  >
}

/** Discriminator on `research_source` events — what kind of corpus
 *  item the research pipeline is inspecting right now. */
export type ResearchSourceKind = "verse" | "lecture_chunk" | "library_doc"

/** Cleanly-decoded SSE event the stream client yields — v1 protocol.
 *  Negotiated via `X-Chat-Protocol-Version: 1` request header. The
 *  variants track the wire-level event names; consumers pattern-match
 *  on `type`. */
export type ChatStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "tool_start"; readonly name?: string }
  | { readonly type: "tool_end"; readonly name?: string }
  | {
      readonly type: "status"
      readonly key: string
      readonly params?: Readonly<Record<string, string | number>>
    }
  | { readonly type: "action"; readonly payload: ChatActionPayload }
  /** Sub-query the research pipeline is about to investigate — emitted
   *  as `query_expander` / `_regenerate_queries` yields its diversified
   *  list. Ephemeral: rendered live under the streaming bubble, cleared
   *  the moment prose deltas start landing. */
  | { readonly type: "research_question"; readonly question: string }
  /** A source the pipeline is inspecting right now (verse, lecture
   *  chunk, library doc). Emitted BEFORE ranking/dedup so the user
   *  sees activity in real-time. Server does NOT dedup — client dedups
   *  by `id`. Wire `kind` field is renamed to `sourceKind` on the
   *  decoded shape to avoid clashing with the `kind` discriminator
   *  used by ActionPayload. */
  | {
      readonly type: "research_source"
      readonly sourceKind: ResearchSourceKind
      readonly id: string
      readonly label: string
    }
  | {
      readonly type: "done"
      /** Alias map for the chip markers in this turn's accumulated
       *  prose. Wire shape kept snake_case to match the agent's
       *  `serialize()` payload; use-case maps to camelCase
       *  `ChatAliasEntry` for the domain. Keys are integer aliases
       *  as strings (JSON limitation). Embedded inline on `done`
       *  per SSE v1 (was a separate `aliases` event in the prototype). */
      readonly aliases?: Readonly<
        Record<string, { track_id: string; start_ms?: number; end_ms?: number }>
      >
      /** The language this turn was answered in, when the server settled one.
       *  Absent when it didn't (nothing to read in the message and nothing
       *  remembered) — then the client keeps what it already had. Persist it on
       *  the assistant message and send it back; see `ChatReplyLanguage`. */
      readonly replyLanguage?: ChatReplyLanguage
    }
  | {
      readonly type: "error"
      readonly code: string
      readonly message: string
      readonly retryAfter?: number
      /** Subscription tier (anonymous|free|pro) the server's rate-limit
       *  decision was made under. Set only on `code: "rate_limited"`;
       *  absent on other codes and on old servers (pre-Phase 4) that
       *  haven't started emitting the extended 429 body yet. */
      readonly tier?: string
      /** Server-side reset boundary in UTC Unix-seconds. Same caveats
       *  as `tier`. The store converts this to an absolute UnixMs and
       *  pins it to the failed bubble so countdowns don't drift across
       *  app backgrounding. */
      readonly resetsAtEpoch?: number
      /** Post-increment counter from the rejecting bucket. Mobile uses
       *  this with `limit` to hydrate the usage chip immediately on a
       *  429 instead of waiting for the next successful turn to emit a
       *  `usage` SSE event. Only set on `code: "rate_limited"`. */
      readonly current?: number
      /** The per-user limit the request was checked against. Pairs with
       *  `current`. Only set on `code: "rate_limited"`. */
      readonly limit?: number
      /** Which bucket exhausted: `"user"` is the per-user JWT cap,
       *  `"ip"` is the per-IP defence-in-depth cap. The chat usage chip
       *  hydrates only on `"user"` — an IP-cap 429 isn't about THIS
       *  user's quota and shouldn't change their displayed usage. */
      readonly keyType?: "user" | "ip"
    }
  /** Per-turn quota chip frame. Emitted in the SSE finally-block so the
   *  client gets it whether the turn succeeded, errored, or was
   *  disconnected. Scope is "chat" for now; future endpoints can reuse
   *  the same event name. */
  | {
      readonly type: "usage"
      readonly scope: string
      readonly current: number
      readonly limit: number
      readonly resetsAtEpoch: number
    }

/**
 * `userContext` snapshot built by the chat composable from listening
 * sessions + notes + player state. Treated as opaque by the port so
 * the wire envelope can evolve without re-typing this interface.
 */
export interface StreamChatOptions {
  readonly signal?: AbortSignal
  readonly userContext?: unknown
  /** Local chat_sessions.id — backend forwards as Langfuse session_id
   *  so all turns of the same conversation group in the Sessions tab. */
  readonly sessionId?: string
  /** Human-readable chat session title (chat_sessions.title). */
  readonly sessionTitle?: string
  /** Pre-minted assistant `ChatMessage.id` (UUIDv4). Adapter strips
   *  hyphens and ships the 32-hex form in `X-Trace-Id` so the server
   *  uses it as the Langfuse trace_id. This makes message identity ==
   *  trace identity, which is what the feedback endpoint relies on. */
  readonly assistantMessageId?: string
  /** When true the server may machine-translate verbatim citations into
   *  `lang` when no native version exists, shipping the translated text
   *  with `mt: true` + the original. Off ⇒ citations stay in their
   *  English-preferred source language. Wire field is `translate_citations`
   *  (snake_case); the adapter maps it. */
  readonly translateCitations?: boolean
  /** Client-declared render capabilities, forwarded to the server as the
   *  `capabilities` map. The server adapts its output to what the client
   *  can render (e.g. `{ commentary_card: true }` → purports shipped as
   *  card payloads + `[commentary:N]` markers instead of inline
   *  blockquotes). Additive + backward-compatible — omitted ⇒ legacy
   *  inline rendering. */
  readonly capabilities?: Readonly<Record<string, boolean>>
}

/**
 * Boundary between the chat workflow (use-cases / store) and the
 * underlying SSE transport. Adapters can wrap fetch+EventSource (Capacitor
 * web), Capacitor HttpPlugin (native), or any other transport — the
 * use-case doesn't care.
 *
 * `lang` is an opaque locale code (`ru`, `en`, `uk`, `sr-Latn`, …) the
 * server threads into its prompts; the client never enumerates it.
 */
export interface IChatStreamClient {
  streamChat(
    turns: readonly ChatTurn[],
    lang: string,
    opts?: StreamChatOptions
  ): AsyncIterable<ChatStreamEvent>
}
