import type {
  ChatActionPayload,
  ChatAliasEntry,
  ChatMessage,
  ChatMessageError,
  ChatOutlinePayload,
} from "@lib/domain/chatMessage.js"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type {
  ChatStreamEvent,
  IChatStreamClient,
  IChatTitleService,
  ChatTurn,
} from "@ports/app/index.js"
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
      readonly kind: "action"
      readonly actionId: string
      readonly payload: ChatActionPayload
    }
  | {
      readonly kind: "outline"
      readonly trackId: string
      readonly payload: ChatOutlinePayload
    }
  | { readonly kind: "finalised"; readonly message: ChatMessage }
  | {
      readonly kind: "error"
      readonly code: string
      readonly message: string
      readonly retryAfter?: number
    }
  | { readonly kind: "title-updated"; readonly title: string }

export interface RunChatTurnInput {
  readonly sessionId: ChatSessionId
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

  // 4. Open stream + fold events.
  let acc = ""
  let sawDone = false
  let sawTurnsLimit = false
  let lastError: { code: string; message: string; retryAfter?: number } | null = null
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
      { signal: input.signal, userContext }
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
          acc = ""
          yield { kind: "tool-start" }
          break
        case "tool":
          break
        case "action":
          actions[event.payload.id] = event.payload
          yield {
            kind: "action",
            actionId: event.payload.id,
            payload: event.payload,
          }
          break
        case "outline":
          outlines[event.payload.trackId] = event.payload
          yield {
            kind: "outline",
            trackId: event.payload.trackId,
            payload: event.payload,
          }
          break
        case "aliases":
          // Server-emitted integer→chunk map for the chip markers in
          // this turn's accumulated `acc`. Persist on the finalised
          // message so the next turn can ship it back and the LLM
          // sees one numbering scheme across the whole conversation.
          aliases = {}
          for (const [k, v] of Object.entries(event.map)) {
            const entry: ChatAliasEntry = { trackId: v.track_id }
            if (typeof v.start_ms === "number") {
              ;(entry as { startMs?: number }).startMs = v.start_ms
            }
            if (typeof v.end_ms === "number") {
              ;(entry as { endMs?: number }).endMs = v.end_ms
            }
            aliases[k] = entry
          }
          break
        case "done":
          sawDone = true
          break
        case "error":
          if (event.code === "max_turns_exceeded") sawTurnsLimit = true
          lastError = {
            code: event.code,
            message: event.message,
            retryAfter: event.retryAfter,
          }
          break
      }
      if (event.type === "done" || event.type === "error") break
    }
  } catch (e) {
    lastError = {
      code: "stream",
      message: e instanceof Error ? e.message : "Stream failed",
    }
  }

  // 5. Decide error marker. !sawDone && acc.length > 0 means the stream
  // dropped after some text — render that as truncated rather than a
  // half-cut silent bubble.
  const errorMeta: ChatMessageError | undefined =
    !sawDone && acc.length > 0
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
  } else if (lastError) {
    yield {
      kind: "error",
      code: lastError.code,
      message: lastError.message,
      retryAfter: lastError.retryAfter,
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
