import type {
  ChatActionPayload,
  ChatAliasEntry,
  ChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
} from "@lib/domain/chatMessage.js"
import {
  BackendUnavailableError,
  ProtocolVersionMismatchError,
} from "@lib/domain/chatMessage.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type {
  ChatActionPayload as WireChatActionPayload,
  IChatStreamClient,
  IChatTitleService,
  ChatTurn,
  ResearchSourceKind,
} from "@lib/contracts"
import type {
  FocusFragmentPayload,
  UserContextPayload,
} from "./buildChatUserContext.js"

/** Snapshot of what the store needs to mutate on every step of the
 *  turn. The use-case yields these as plain events; the store
 *  translates each into reactive mutations. */
export type RunChatTurnEvent =
  | { readonly kind: "user-message"; readonly message: ChatMessage }
  | {
      readonly kind: "assistant-placeholder"
      readonly messageId: ChatMessageId
    }
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "tool-start" }
  | {
      readonly kind: "status"
      /** Server-emitted i18n key — e.g. "searching_corpus",
       *  "composing_answer". The store maps it to a localized label
       *  via `t(`chat.status.${statusKey}`, params)`. */
      readonly statusKey: string
      readonly params?: Readonly<Record<string, string | number>>
    }
  | {
      readonly kind: "action"
      readonly actionId: string
      readonly payload: ChatActionPayload
    }
  | {
      readonly kind: "outline"
      readonly trackId: string
      readonly payload: ChatOutlinePayload
    }
  | {
      readonly kind: "verse-payload"
      readonly sourceId: string
      readonly tokens: string
      readonly addrLabel: string
      readonly sanskrit: string
      readonly transliteration: string
      readonly translation: { readonly [lang: string]: string }
      readonly audioUrl?: string
    }
  /** Chapter-location region for one `[chapter:source/region|label]`
   *  marker (locate intent), streamed ahead of its marker. The store
   *  caches it so `ChapterCard.vue` renders the chapter list; absent ⇒
   *  the chip fallback. */
  | {
      readonly kind: "chapter-payload"
      readonly sourceId: string
      readonly regionToken: string
      readonly regionLabel: string
      readonly chapters: readonly { readonly tokens: string; readonly title: string }[]
    }
  /** Transcript snippet for one `[cite:track@start-end|caption]`
   *  fragment, streamed ahead of its marker. The store caches it so
   *  `CitationCard.vue` renders the full quote block; absent ⇒ the chip
   *  fallback. */
  | {
      readonly kind: "cite-transcript-payload"
      readonly trackId: string
      readonly startMs: number
      readonly endMs: number
      readonly text: string
    }
  /** Sub-query the research pipeline just generated — append to the
   *  live "investigating" list under the streaming bubble. The store
   *  does not persist these: when the prose deltas start landing the
   *  status pill (and this list) collapse together. */
  | { readonly kind: "research-question"; readonly question: string }
  /** A source the pipeline is inspecting right now. Dedup is the
   *  store's job — keyed by `id` so the same chunk surfaced from
   *  multiple sub-queries collapses to one chip. */
  | {
      readonly kind: "research-source"
      readonly sourceKind: ResearchSourceKind
      readonly id: string
      readonly label: string
    }
  | { readonly kind: "finalised"; readonly message: ChatMessage }
  | {
      readonly kind: "error"
      readonly code: string
      readonly message: string
      readonly retryAfter?: number
      /** Quota tier the limit was looked up under ("anonymous" | "free"
       *  | "pro"). Set only on `code: "rate_limited"`; absent for other
       *  error codes and for old servers (pre-Phase 4) that don't yet
       *  emit this field. The store keys the inline-notice copy + CTA
       *  off this. */
      readonly tier?: string
      /** Server-side reset boundary in UTC Unix-seconds. Same caveats
       *  as `tier`. Store converts to absolute UnixMs before persisting
       *  on the ChatMessageError so countdowns survive backgrounding. */
      readonly resetsAtEpoch?: number
      /** Post-increment counter for the rejecting bucket. The store
       *  uses this with `limit` to hydrate the usage chip from the
       *  429 body. Only set on `code: "rate_limited"`. */
      readonly current?: number
      /** Per-user limit the request was checked against. */
      readonly limit?: number
      /** Which bucket exhausted: `user` (per-JWT) vs `ip` (per-IP). The
       *  usage chip only hydrates on `user`; `ip` means a CGNAT peer
       *  hammered the IP cap and this user's quota is fine. */
      readonly keyType?: "user" | "ip"
    }
  /** Per-turn quota chip frame. Emitted by the server's SSE finally-block
   *  on success, LLM error, and client disconnect. Store sets `chatUsage`
   *  and persists. */
  | {
      readonly kind: "usage"
      readonly scope: string
      readonly current: number
      readonly limit: number
      readonly resetsAtEpoch: number
    }
  | { readonly kind: "title-updated"; readonly title: string }

export interface RunChatTurnInput {
  readonly sessionId: ChatSessionId
  /** Optional human-readable title of the active chat session. Forwarded
   *  to the server so Langfuse can group turns of the same conversation
   *  in its Sessions tab and label them with the user-visible title
   *  instead of a UUID. */
  readonly sessionTitle?: string
  /** Trimmed, non-empty user prompt. */
  readonly text: string
  readonly lang: "ru" | "en"
  /** Prior conversation as sent to the LLM. */
  readonly history: readonly ChatTurn[]
  readonly focus?: FocusFragmentPayload
  /** True for the first assistant reply in a session — controls the
   *  background title refresh. */
  readonly isFirstAssistantTurn: boolean
  /** Random id factory injected so tests can pin output. */
  readonly newMessageId: () => ChatMessageId
  /** AbortSignal — closed by the store's cancelStream. */
  readonly signal: AbortSignal
}

export interface RunChatTurnDeps {
  readonly sessions: IChatSessionRepository
  readonly messages: IChatMessageRepository
  readonly stream: IChatStreamClient
  readonly title: IChatTitleService
  /** Built per-call by the consumer (composable) so player state is
   *  fresh. The use-case stays pinia-free. */
  readonly buildUserContext: (
    focus?: FocusFragmentPayload
  ) => Promise<UserContextPayload>
  /** Pull `[followup:<text>]` chip texts out of the final assistant
   *  content. Strict parser — malformed markers leak into prose and
   *  return no chip (fix lives in the prompt, not here). */
  readonly extractFollowups: (content: string) => readonly string[]
  /** Optional: refresh the auth claim right before the SSE stream opens
   *  so a tier flip that happened while backgrounded is attached to this
   *  turn. Called AFTER the user message + placeholder are yielded, so it
   *  never delays the user's own bubble — only the assistant reply waits
   *  on it. Best-effort: runChatTurn swallows its errors. */
  readonly ensureFresh?: () => Promise<void>
}

/**
 * Run one chat turn end-to-end and yield observable events.
 *
 * The use-case persists the user prompt + the finalised assistant
 * reply, opens the SSE stream, folds events, and fires a background
 * title refresh on the first turn of a session. Mutations on the
 * in-memory bubble (delta accumulation, action/outline merging) are
 * the consumer's job — the store's send loop subscribes and reflects.
 *
 * `signal.aborted` short-circuits both the stream and the finalise
 * branch. The cancel path still tries to persist any text streamed so
 * far with a `truncated: stream` error marker — same UX promise as
 * the in-store version, just exhibited through a yielded event.
 */
export async function* runChatTurn(
  input: RunChatTurnInput,
  deps: RunChatTurnDeps
): AsyncIterable<RunChatTurnEvent> {
  const now = Date.now()

  // 1. Persist user message.
  const userMsg = await deps.messages.create({
    id: input.newMessageId(),
    sessionId: input.sessionId,
    role: "user",
    content: input.text,
    createdAt: now,
  })
  await deps.sessions.touch(input.sessionId, now)
  yield { kind: "user-message", message: userMsg }

  // 2. Optimistic assistant placeholder.
  const assistantId = input.newMessageId()
  yield { kind: "assistant-placeholder", messageId: assistantId }

  // 3. Build UserContext (delegated; the composable injects player state).
  let userContext: unknown = undefined
  try {
    userContext = await deps.buildUserContext(input.focus)
  } catch {
    // Server tolerates missing user_context — degrade gracefully.
  }

  // 3b. Refresh the auth claim just before opening the stream. This runs
  // AFTER the user message + placeholder have been yielded, so the user
  // sees their bubble instantly and only the assistant reply waits on the
  // network. Best-effort — a stale claim still attempts the stream.
  if (deps.ensureFresh) {
    try {
      await deps.ensureFresh()
    } catch {
      // ensureFresh swallows its own errors; this guards a sync throw.
    }
  }

  // 4. Open stream + fold events.
  let acc = ""
  let sawDone = false
  let sawTurnsLimit = false
  let lastError: {
    code: string
    message: string
    retryAfter?: number
    tier?: string
    resetsAtEpoch?: number
    current?: number
    limit?: number
    keyType?: "user" | "ip"
  } | null = null
  const actions: Record<string, ChatActionPayload> = {}
  const outlines: Record<string, ChatOutlinePayload> = {}
  let aliases: Record<string, ChatAliasEntry> | undefined

  // The history passed by the caller is the conversation BEFORE this
  // turn (caller has no clean way to splice the new user message in
  // without a race against the store's reactive update). Append the
  // just-persisted user prompt here so the wire payload always has
  // ≥ 1 message — the server's ChatRequest.messages has min_length=1.
  const turnsForServer: readonly ChatTurn[] = [
    ...input.history,
    { role: "user", content: input.text },
  ]

  try {
    for await (const event of deps.stream.streamChat(
      turnsForServer,
      input.lang,
      {
        signal: input.signal,
        userContext,
        sessionId: input.sessionId,
        sessionTitle: input.sessionTitle,
        // Pre-minted assistant id flows through to the adapter, which
        // ships it as `X-Trace-Id` so the server's Langfuse trace is
        // keyed on the same value. Feedback POSTs later reference this
        // exact id (hyphenless on the wire) to land scores on the
        // right trace.
        assistantMessageId: assistantId,
      }
    )) {
      if (input.signal.aborted) break
      // Mutate the closure state used by the finalise branch + yield
      // the consumer-facing event so the store can reflect on the
      // reactive bubble immediately.
      switch (event.type) {
        case "delta":
          acc += event.text
          yield { kind: "delta", text: event.text }
          break
        case "tool_start":
          // A re-run of a tool discards the first pass entirely: reset
          // the prose accumulator AND the per-turn action/outline maps,
          // otherwise the finalised message would carry orphaned cards
          // emitted before the tool re-ran.
          acc = ""
          for (const k of Object.keys(actions)) delete actions[k]
          for (const k of Object.keys(outlines)) delete outlines[k]
          yield { kind: "tool-start" }
          break
        case "tool_end":
          break
        case "status":
          // i18n status label for the thinking pill. Use-case forwards
          // verbatim — the store decides whether to render it.
          yield { kind: "status", statusKey: event.key, params: event.params }
          break
        case "research_question":
          // Live progress event from the research pipeline. Forwarded
          // verbatim — the store appends to the streaming bubble's
          // ephemeral `researchQuestions` list; nothing folded into
          // closure state because these never end up persisted.
          yield { kind: "research-question", question: event.question }
          break
        case "research_source":
          // Live progress event — a source the pipeline is inspecting
          // right now. Forwarded verbatim; the store dedups by `id` and
          // drops the whole map when prose deltas start landing.
          yield {
            kind: "research-source",
            sourceKind: event.sourceKind,
            id: event.id,
            label: event.label,
          }
          break
        case "action": {
          // Auto-render kinds paired with inline markers: outline and
          // verse fan out into the outline/verse-payload bubble streams
          // so the existing component wiring keeps working without
          // every consumer learning to switch on action.kind.
          if (event.payload.kind === "outline") {
            outlines[event.payload.payload.trackId] = event.payload.payload
            yield {
              kind: "outline",
              trackId: event.payload.payload.trackId,
              payload: event.payload.payload,
            }
            break
          }
          if (event.payload.kind === "verse") {
            yield {
              kind: "verse-payload",
              sourceId: event.payload.payload.source_id,
              tokens: event.payload.payload.tokens,
              addrLabel: event.payload.payload.addr_label,
              sanskrit: event.payload.payload.sanskrit,
              transliteration: event.payload.payload.transliteration,
              translation: event.payload.payload.translation,
              audioUrl: event.payload.payload.audio_url,
            }
            break
          }
          if (event.payload.kind === "cite_transcript") {
            yield {
              kind: "cite-transcript-payload",
              trackId: event.payload.payload.track_id,
              startMs: event.payload.payload.start_ms,
              endMs: event.payload.payload.end_ms,
              text: event.payload.payload.text,
            }
            break
          }
          if (event.payload.kind === "chapter") {
            yield {
              kind: "chapter-payload",
              sourceId: event.payload.payload.source_id,
              regionToken: event.payload.payload.region_token,
              regionLabel: event.payload.payload.region_label,
              chapters: event.payload.payload.chapters,
            }
            break
          }
          // Interactive widgets: unwrap wire `{kind, id, payload: {…}}`
          // into the flat domain `ChatActionPayload` shape that the
          // store persists and ActionCard*.vue components read from.
          // Domain stays flat so SQLite migration isn't needed and
          // existing components don't change; wire stays nested per
          // SSE v1 (plan §11.3).
          const flat = unwrapInteractiveAction(event.payload)
          if (flat === null) break
          actions[flat.id] = flat
          yield {
            kind: "action",
            actionId: flat.id,
            payload: flat,
          }
          break
        }
        case "done":
          // v1: alias map ships inline with `done`. Persist on the
          // finalised message so the next turn can ship it back and
          // the LLM sees one numbering scheme across the conversation.
          if (event.aliases) {
            aliases = {}
            for (const [k, v] of Object.entries(event.aliases)) {
              const entry: ChatAliasEntry = { trackId: v.track_id }
              if (typeof v.start_ms === "number") {
                ;(entry as { startMs?: number }).startMs = v.start_ms
              }
              if (typeof v.end_ms === "number") {
                ;(entry as { endMs?: number }).endMs = v.end_ms
              }
              aliases[k] = entry
            }
          }
          sawDone = true
          break
        case "error":
          if (event.code === "max_turns_exceeded") sawTurnsLimit = true
          lastError = {
            code: event.code,
            message: event.message,
            retryAfter: event.retryAfter,
            tier: event.tier,
            resetsAtEpoch: event.resetsAtEpoch,
            current: event.current,
            limit: event.limit,
            keyType: event.keyType,
          }
          break
        case "usage":
          // Per-turn quota chip frame from the server's SSE finally-block.
          // Forwarded verbatim; the store sets `chatUsage` + persists
          // under `chat_usage:<quota_id>`. Doesn't fold into the message
          // or `lastError` — it's a sidecar.
          yield {
            kind: "usage",
            scope: event.scope,
            current: event.current,
            limit: event.limit,
            resetsAtEpoch: event.resetsAtEpoch,
          }
          break
      }
      // Server emits `usage` AFTER terminal events (`done` / `error`)
      // from its SSE finally-block. Don't break on terminal here — wait
      // for the underlying stream to close so the usage frame reaches us.
    }
  } catch (e) {
    // Typed structural failures (protocol mismatch, backend unavailable)
    // bypass the inline failed-bubble path — the store catches and
    // surfaces them as toasts with their own copy + CTA. Bucketing them
    // into a generic `code: "stream"` event would land them on the
    // generic "couldn't get a response" message and lose the actionable
    // signal (e.g. "update the app").
    if (
      e instanceof ProtocolVersionMismatchError ||
      e instanceof BackendUnavailableError
    ) {
      throw e
    }
    lastError = {
      code: "stream",
      message: e instanceof Error ? e.message : "Stream failed",
    }
  }

  // 5. Decide error marker. The signal-aborted branch wins over a
  // generic truncated/stream — a user-initiated stop is intentional,
  // not a connection drop, so we render the neutral "Stopped" copy
  // instead of "connection dropped". `!sawDone && acc.length > 0` is
  // the catch-all truncated path for real network truncations.
  //
  // Gate "stopped" on `!sawDone`: the server emits `usage` AFTER the
  // terminal `done`, so the loop keeps reading past `done` to capture
  // that frame. A user abort that lands in this post-terminal window
  // would otherwise relabel a fully-completed answer as "stopped" —
  // once `done` arrived the turn is finished, so an abort after it is
  // a no-op for the error marker.
  const errorMeta: ChatMessageError | undefined =
    input.signal.aborted && !sawDone
      ? { kind: "stopped" }
      : !sawDone && acc.length > 0
        ? { kind: "truncated", reason: sawTurnsLimit ? "turns" : "stream" }
        : undefined

  if (acc.length > 0) {
    const followups = deps.extractFollowups(acc)
    const finalised = await deps.messages.create({
      id: assistantId,
      sessionId: input.sessionId,
      role: "assistant",
      content: acc,
      createdAt: Date.now(),
      actions,
      outlines,
      error: errorMeta,
      followups: followups.length > 0 ? followups : undefined,
      aliases,
    })
    await deps.sessions.touch(input.sessionId, finalised.createdAt)
    yield { kind: "finalised", message: finalised }
  } else if (input.signal.aborted && !sawDone) {
    // User tapped stop before any prose landed (and before `done`).
    // Nothing useful to preserve, and converting the placeholder to a
    // "no content" failed-bubble would suggest something went wrong —
    // it didn't, the user just changed their mind. Emit a dedicated
    // code the store recognises so it can drop the placeholder
    // silently. `!sawDone` mirrors the errorMeta gate above: an abort
    // landing in the post-`done` usage wait is a completed (empty)
    // turn, not a user stop.
    yield { kind: "error", code: "stopped_empty", message: "stopped" }
  } else if (lastError) {
    yield {
      kind: "error",
      code: lastError.code,
      message: lastError.message,
      retryAfter: lastError.retryAfter,
      ...(lastError.tier !== undefined ? { tier: lastError.tier } : {}),
      ...(lastError.resetsAtEpoch !== undefined ? { resetsAtEpoch: lastError.resetsAtEpoch } : {}),
      ...(lastError.current !== undefined ? { current: lastError.current } : {}),
      ...(lastError.limit !== undefined ? { limit: lastError.limit } : {}),
      ...(lastError.keyType !== undefined ? { keyType: lastError.keyType } : {}),
    }
  } else {
    // No text and no error — empty `done`. Store drops the placeholder.
    yield {
      kind: "error",
      code: "empty",
      message: "no content",
    }
  }

  // 7. Background title refresh — first turn only, only when we got an
  // assistant reply. If `/title` returns null or throws, the session
  // keeps its locally-derived (or null) title — no retry mechanism,
  // the UI falls back to a generic header.
  if (input.isFirstAssistantTurn && acc.length > 0) {
    const turns: readonly ChatTurn[] = [
      { role: "user", content: input.text },
      { role: "assistant", content: acc },
    ]
    try {
      const newTitle = await deps.title.fetchSessionTitle(turns, input.lang, {
        signal: input.signal,
      })
      if (newTitle) {
        await deps.sessions.updateTitle(input.sessionId, newTitle)
        yield { kind: "title-updated", title: newTitle }
      }
    } catch {
      // /title backend is broken or call aborted — accept the null
      // title and move on. Generic header is fine.
    }
  }

}

/**
 * Wire-to-domain converter for interactive action payloads.
 *
 * The wire (SSE v1) nests kind-specific fields under `payload`; the
 * domain (persisted on chat_messages.actions) keeps the legacy flat
 * shape so existing SQLite rows + ActionCard*.vue components don't
 * need a migration. This function bridges that one place.
 *
 * Auto-render kinds (`outline`, `verse`) are handled by the caller —
 * they don't get persisted as ChatActionPayload, they fan out into
 * separate streams.
 *
 * Returns `null` if the wire payload was malformed (unknown kind, or
 * required fields missing). Caller drops the event in that case so a
 * server bug doesn't crash the bubble render.
 */
function unwrapInteractiveAction(
  wire: WireChatActionPayload
): ChatActionPayload | null {
  switch (wire.kind) {
    case "share_pdf":
      return {
        kind: "share_pdf",
        id: wire.id,
        items: wire.payload.items,
      }
    case "enable_daily_reminder":
      return {
        kind: "enable_daily_reminder",
        id: wire.id,
        time: wire.payload.time,
      }
    case "configure_smart_library":
      return {
        kind: "configure_smart_library",
        id: wire.id,
        filters: wire.payload.filters,
      }
    case "upgrade_to_pro":
      return {
        kind: "upgrade_to_pro",
        id: wire.id,
        reason: wire.payload.reason,
      }
    default:
      // outline / verse — handled upstream as separate event streams
      return null
  }
}
