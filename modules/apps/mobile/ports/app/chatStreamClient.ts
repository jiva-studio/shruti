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

export interface ChatSharePdfItemPayload {
  readonly trackId: string
  readonly lang: string
  readonly title: string
  readonly author: string | null
  readonly date: string | null
  readonly pdfUrl: string
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
  readonly translation: Readonly<Record<string, string>>
}

export type ChatRole = "user" | "assistant"

export interface ChatTurn {
  readonly role: ChatRole
  readonly content: string
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
  /** Turn-metadata, first event of the SSE stream. Carries the Langfuse
   *  `trace_id` the client uses to identify this assistant message
   *  when POSTing feedback later. Additive — old clients ignore. */
  | { readonly type: "meta"; readonly traceId: string }
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
      /** Fallback echo of the `meta` event's trace_id — set so a client
       *  that missed the initial event (e.g. an SSE reconnect) still
       *  recovers the message identifier on stream close. */
      readonly traceId?: string
      /** Alias map for the chip markers in this turn's accumulated
       *  prose. Wire shape kept snake_case to match the agent's
       *  `serialize()` payload; use-case maps to camelCase
       *  `ChatAliasEntry` for the domain. Keys are integer aliases
       *  as strings (JSON limitation). Embedded inline on `done`
       *  per SSE v1 (was a separate `aliases` event in the prototype). */
      readonly aliases?: Readonly<
        Record<string, { track_id: string; start_ms?: number; end_ms?: number }>
      >
    }
  | {
      readonly type: "error"
      readonly code: string
      readonly message: string
      readonly retryAfter?: number
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
}

/**
 * Boundary between the chat workflow (use-cases / store) and the
 * underlying SSE transport. Adapters can wrap fetch+EventSource (Capacitor
 * web), Capacitor HttpPlugin (native), or any other transport — the
 * use-case doesn't care.
 */
export interface IChatStreamClient {
  streamChat(
    turns: readonly ChatTurn[],
    lang: "ru" | "en",
    opts?: StreamChatOptions
  ): AsyncIterable<ChatStreamEvent>
}
