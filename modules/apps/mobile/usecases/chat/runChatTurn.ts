import type {
  ChatActionPayload,
  ChatAliasEntry,
  ChatChapterBody,
  ChatCiteSnippet,
  ChatCommentaryBody,
  ChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
  ChatVerseBody,
  MediaPayload,
} from "@lib/domain/chatMessage.js"
import { BackendUnavailableError, ProtocolVersionMismatchError } from "@lib/domain/chatMessage.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type {
  ChatActionPayload as WireChatActionPayload,
  ChatStreamEvent,
  IChatStreamClient,
  IChatTitleService,
  ChatTurn,
  ResearchSourceKind,
} from "@lib/contracts"
import type { FocusFragmentPayload, UserContextPayload } from "./buildChatUserContext.js"

/** Render capabilities this build advertises to the chat server, which adapts
 *  its output: `commentary_card` → purports as cards not inline blockquotes;
 *  `personal_library` → web-discovered lectures as add-to-library cards.
 *  Additive; a server that doesn't know a key ignores it. */
const CLIENT_CAPABILITIES = { commentary_card: true, personal_library: true } as const

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
      /** Original IAST (Latin) transliteration; present only when the shown
       *  one is a different script. Flips with the translation on toggle. */
      readonly transliterationOriginal?: string
      readonly translation: { readonly [lang: string]: string }
      readonly audioUrl?: string
      /** True when `translation[lang]` is a machine translation — the card
       *  surfaces a footnote + toggle to the original `translation.en`. */
      readonly mt?: boolean
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
      /** True when `text` is a machine translation — the card surfaces a
       *  footnote + toggle to `textOriginal`. */
      readonly mt?: boolean
      /** Verbatim source-language transcript, present only when `mt`. */
      readonly textOriginal?: string
    }
  /** Purport / prose-chapter / letter citation for one `[commentary:<ref>]`
   *  marker, streamed ahead of it (audio-citation shape). The store caches
   *  it by `ref` so `CommentaryCard.vue` renders the quote as a card
   *  (text + author + reference); absent ⇒ nothing renders for the marker. */
  | {
      readonly kind: "commentary-payload"
      readonly ref: number
      readonly text: string
      readonly authorName: string
      readonly addrLabel: string
      /** Source kind: "commentary" | "prose_chapter" | "letter". */
      readonly commentaryKind: string
      /** True when `text` is a machine translation — the card surfaces a
       *  footnote + toggle to `textOriginal`. */
      readonly mt?: boolean
      /** Verbatim source-language quote, present only when `mt`. */
      readonly textOriginal?: string
    }
  /** Media result (video/audio file + transcript) for one
   *  `[media:<id>|<caption>]` marker, streamed ahead of its marker. The
   *  store stashes it on `ChatMessage.media[id]` so `MediaCard.vue`
   *  renders the player + transcript; absent ⇒ the marker renders nothing
   *  (guarded like the other cards). */
  | {
      readonly kind: "media-payload"
      readonly payload: MediaPayload
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
  /** Opaque locale code for the answer (`ru`, `en`, `uk`, `sr-Latn`, …)
   *  — threaded to the server's prompts verbatim, never enumerated. */
  readonly lang: string
  /** When true, ask the server to machine-translate verbatim citations
   *  into `lang` when no native version exists. Default off. */
  readonly translateCitations?: boolean
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
  /** Pin the assistant message id instead of minting a fresh one. Set on
   *  the resume path so the replayed reply overwrites the original
   *  placeholder. Live turns omit it. */
  readonly assistantMessageId?: ChatMessageId
  /** Resume path: a pre-built stream of the turn's buffered events
   *  (parsed from the server's turn store). When present, runChatTurn
   *  skips the user-message persist + context build + opening a real SSE
   *  stream, and re-folds these events into the finalised message through
   *  the exact same logic the live turn uses — no second parser. */
  readonly replayEvents?: AsyncIterable<ChatStreamEvent>
}

export interface RunChatTurnDeps {
  readonly sessions: IChatSessionRepository
  readonly messages: IChatMessageRepository
  /** Pull `[followup:<text>]` chip texts out of the final assistant
   *  content. Strict parser — malformed markers leak into prose and
   *  return no chip (fix lives in the prompt, not here). */
  readonly extractFollowups: (content: string) => readonly string[]
  /** Live-stream deps — required for a live turn, unused on the resume /
   *  replay path (gated by `input.replayEvents`). Optional so the
   *  `replayChatTurn` use-case can run a turn off buffered events without
   *  fabricating a stream / title service / context builder it never calls. */
  readonly stream?: IChatStreamClient
  readonly title?: IChatTitleService
  /** Built per-call by the consumer (composable) so player state is fresh.
   *  The use-case stays pinia-free. */
  readonly buildUserContext?: (focus?: FocusFragmentPayload) => Promise<UserContextPayload>
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

  // 1. Persist user message. Skipped on the resume path — the user
  // message was already persisted by the original live turn.
  if (!input.replayEvents) {
    const userMsg = await deps.messages.create({
      id: input.newMessageId(),
      sessionId: input.sessionId,
      role: "user",
      content: input.text,
      createdAt: now,
    })
    await deps.sessions.touch(input.sessionId, now)
    yield { kind: "user-message", message: userMsg }
  }

  // 2. Optimistic assistant placeholder. On resume the id is pinned to the
  // original assistant message so the replay overwrites it.
  const assistantId = input.assistantMessageId ?? input.newMessageId()
  yield { kind: "assistant-placeholder", messageId: assistantId }

  // 3. Build UserContext + refresh auth — live path only. The resume path
  // has no real stream to open, so neither is needed.
  let userContext: unknown = undefined
  if (!input.replayEvents) {
    try {
      userContext = await deps.buildUserContext?.(input.focus)
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
  const media: Record<string, MediaPayload> = {}
  // Card bodies for verse / cite / chapter / commentary markers, keyed
  // exactly as the matching `ChatMessage` fields. Accumulated like `media`
  // so the finalised message persists them — the card then survives a
  // reopen instead of degrading to a chip once an in-memory cache churns.
  const verses: Record<string, ChatVerseBody> = {}
  const cites: Record<string, ChatCiteSnippet> = {}
  const chapters: Record<string, ChatChapterBody> = {}
  const commentaries: Record<string, ChatCommentaryBody> = {}
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

  // Resume path replays the buffered events; live path opens the SSE
  // stream (requires the live-only `deps.stream`). Both feed the SAME fold.
  let eventSource: AsyncIterable<ChatStreamEvent>
  if (input.replayEvents) {
    eventSource = input.replayEvents
  } else {
    if (!deps.stream) {
      throw new Error("runChatTurn: a live turn requires deps.stream")
    }
    eventSource = deps.stream.streamChat(turnsForServer, input.lang, {
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
      translateCitations: input.translateCitations,
      capabilities: CLIENT_CAPABILITIES,
    })
  }

  try {
    for await (const event of eventSource) {
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
          for (const k of Object.keys(media)) delete media[k]
          for (const k of Object.keys(verses)) delete verses[k]
          for (const k of Object.keys(cites)) delete cites[k]
          for (const k of Object.keys(chapters)) delete chapters[k]
          for (const k of Object.keys(commentaries)) delete commentaries[k]
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
            const p = event.payload.payload
            verses[`${p.source_id}|${p.tokens}`] = {
              addrLabel: p.addr_label,
              sanskrit: p.sanskrit,
              transliteration: p.transliteration,
              transliterationOriginal: p.transliteration_original,
              translation: p.translation,
              audioUrl: p.audio_url,
              mt: p.mt,
            }
            yield {
              kind: "verse-payload",
              sourceId: p.source_id,
              tokens: p.tokens,
              addrLabel: p.addr_label,
              sanskrit: p.sanskrit,
              transliteration: p.transliteration,
              transliterationOriginal: p.transliteration_original,
              translation: p.translation,
              audioUrl: p.audio_url,
              mt: p.mt,
            }
            break
          }
          if (event.payload.kind === "cite_transcript") {
            const p = event.payload.payload
            cites[`${p.track_id}|${p.start_ms}-${p.end_ms}`] = {
              text: p.text,
              mt: p.mt,
              textOriginal: p.text_original,
            }
            yield {
              kind: "cite-transcript-payload",
              trackId: p.track_id,
              startMs: p.start_ms,
              endMs: p.end_ms,
              text: p.text,
              mt: p.mt,
              textOriginal: p.text_original,
            }
            break
          }
          if (event.payload.kind === "commentary") {
            const p = event.payload.payload
            commentaries[String(p.ref)] = {
              text: p.text,
              authorName: p.author_name,
              addrLabel: p.addr_label,
              commentaryKind: p.kind,
              mt: p.mt,
              textOriginal: p.text_original,
            }
            yield {
              kind: "commentary-payload",
              ref: p.ref,
              text: p.text,
              authorName: p.author_name,
              addrLabel: p.addr_label,
              commentaryKind: p.kind,
              mt: p.mt,
              textOriginal: p.text_original,
            }
            break
          }
          if (event.payload.kind === "chapter") {
            const p = event.payload.payload
            chapters[`${p.source_id}|${p.region_token}`] = {
              regionLabel: p.region_label,
              chapters: p.chapters,
            }
            yield {
              kind: "chapter-payload",
              sourceId: p.source_id,
              regionToken: p.region_token,
              regionLabel: p.region_label,
              chapters: p.chapters,
            }
            break
          }
          if (event.payload.kind === "media") {
            // Map the snake_case wire payload to the camelCase domain
            // `MediaPayload` (the one boundary that does this, same as the
            // verse/cite/chapter/commentary branches above). Stash on the
            // closure `media` map so the finalised message persists it
            // (mirrors `actions`/`outlines`), and yield so the store reflects
            // it on the streaming bubble before the `[media:<id>]` marker
            // triggers MediaCard render.
            const w = event.payload.payload
            const mp: MediaPayload = {
              id: w.id,
              url: w.url,
              type: w.type,
              title: w.title,
              text: w.text,
              ...(w.speaker ? { speaker: w.speaker } : {}),
              ...(w.mt ? { mt: true } : {}),
              ...(w.text_original ? { textOriginal: w.text_original } : {}),
            }
            media[mp.id] = mp
            yield { kind: "media-payload", payload: mp }
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
    if (e instanceof ProtocolVersionMismatchError || e instanceof BackendUnavailableError) {
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
      media,
      verses,
      cites,
      chapters,
      commentaries,
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
  if (input.isFirstAssistantTurn && acc.length > 0 && deps.title) {
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
function unwrapInteractiveAction(wire: WireChatActionPayload): ChatActionPayload | null {
  switch (wire.kind) {
    case "share_pdf":
      return {
        kind: "share_pdf",
        id: wire.id,
        items: wire.payload.items,
      }
    case "add_to_library":
      return {
        kind: "add_to_library",
        id: wire.id,
        url: wire.payload.url,
        title: wire.payload.title,
        author: wire.payload.author,
        thumbnail: wire.payload.thumbnail,
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
