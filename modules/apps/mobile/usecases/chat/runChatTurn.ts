import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { IChatMessageRepository } from "@lib/domain/ports/chatMessageRepository.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type {
  ChatStreamEvent,
  IChatStreamClient,
  IChatTitleService,
  ChatTurn,
} from "@lib/contracts"
import type { FocusFragmentPayload, UserContextPayload } from "./buildChatUserContext.js"

/** Render capabilities this build advertises to the chat server, which adapts
 *  its output: `commentary_card` → purports as cards not inline blockquotes;
 *  `personal_library` → web-discovered lectures as add-to-library cards.
 *  Additive; a server that doesn't know a key ignores it. */
const CLIENT_CAPABILITIES = { commentary_card: true, personal_library: true } as const

import type { RunChatTurnEvent } from "./chatTurnEvents.js"
import { createTurnCards } from "./chatActionFold.js"
import { createFoldState, foldChatStream } from "./chatStreamFold.js"
import { finaliseTurn, refreshSessionTitle } from "./finaliseChatTurn.js"

export type { RunChatTurnEvent } from "./chatTurnEvents.js"

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
  /** Timestamp to stamp the finalised assistant row with, instead of "now".
   *  Resume path only: a turn recovered after the user asked something else
   *  would otherwise sort BELOW the newer question the next time the session
   *  is read off disk. Pin it to when the turn actually started. */
  readonly finalisedCreatedAt?: number
}

export interface RunChatTurnDeps {
  /** The clock. Bound by the composition root; a use case does not reach for one. */
  readonly now: () => number
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
  const clock = deps.now
  const now = clock()

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
  const cards = createTurnCards()
  const state = createFoldState()

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

  yield* foldChatStream(eventSource, cards, state, input.signal)

  yield* finaliseTurn(input, deps, assistantId, cards, state)
  yield* refreshSessionTitle(input, deps, state)
}
