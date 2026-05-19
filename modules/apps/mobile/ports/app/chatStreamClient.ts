/**
 * Wire payloads emitted by the chat agent as SSE side-events. These
 * types are duplicated (intentionally) on the domain side as
 * `ChatActionPayload` / `ChatOutlinePayload` on `ChatMessage`. Ports
 * must not import `@lib/domain` (clean-architecture rule), and domain
 * must not import ports either — both layers redeclare the wire
 * contract independently and the composition root reconciles them.
 */
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

/** Cleanly-decoded SSE event the stream client yields. The variants
 *  track the wire-level event names; consumers pattern-match on `type`. */
export type ChatStreamEvent =
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "tool_start"; readonly name: string }
  | {
      readonly type: "tool"
      readonly name: string
      readonly durationMs?: number
      readonly resultCount?: number
    }
  | { readonly type: "action"; readonly payload: ChatActionPayload }
  | { readonly type: "outline"; readonly payload: ChatOutlinePayload }
  | {
      readonly type: "aliases"
      /** Wire shape kept snake_case to match the agent's
       *  `serialize()` payload; the use-case layer maps to camelCase
       *  `ChatAliasEntry` for the domain. Keys are integer aliases
       *  serialised as strings (JSON limitation). */
      readonly map: Readonly<
        Record<string, { track_id: string; start_ms?: number; end_ms?: number }>
      >
    }
  | {
      readonly type: "done"
      readonly requestId?: string
      readonly totalTokens?: number
      readonly toolCalls?: number
      readonly durationMs?: number
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
