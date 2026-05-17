import type {
  ChatActionPayload,
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
  /** Synthesize a playlist payload when the LLM emitted
   *  `[action:create-playlist|id=X]` without calling propose_playlist
   *  (a known DeepSeek failure mode). Returns the merged action map
   *  or `existing` unchanged if salvage isn't applicable. */
  readonly salvageOrphanActions: (
    content: string,
    existing: Record<string, ChatActionPayload>,
    fallbackName: string
  ) => Record<string, ChatActionPayload>
  /** Localised fallback name when the salvage can't infer one from the
   *  user prompt. */
  readonly fallbackPlaylistName: string
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

  try {
    for await (const event of deps.stream.streamChat(
      input.history,
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

  // 6. Salvage orphan actions from the final content (LLM may have
  // emitted `[action:create-playlist|id=X]` without calling
  // propose_playlist; the salvage walker rebuilds from sibling cards).
  const mergedActions = deps.salvageOrphanActions(
    acc,
    actions,
    input.text.slice(0, 60) || deps.fallbackPlaylistName
  )

  if (acc.length > 0) {
    const finalised = await deps.messages.create({
      id: assistantId,
      sessionId: input.sessionId,
      role: "assistant",
      content: acc,
      createdAt: Date.now(),
      actions: mergedActions,
      outlines,
      error: errorMeta,
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
  // assistant reply. Failures bump the attempt counter so the
  // foreground retry worker can pick the session up.
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
      } else {
        await deps.sessions.incrementTitleAttempt(input.sessionId)
      }
    } catch {
      try {
        await deps.sessions.incrementTitleAttempt(input.sessionId)
      } catch {
        // Persist failure on the counter is benign — retry worker picks
        // up the next opportunity anyway.
      }
    }
  }

}
