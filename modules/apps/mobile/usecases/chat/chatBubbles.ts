import type { ChatMessageError } from "@lib/domain"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { ChatMessage } from "./chatThread.js"

/**
 * The assistant bubble ONE fold is allowed to write into.
 *
 * Every fold — the live turn, a resume replay, a placeholder re-raised on
 * session open — carries its own, minted by whoever owns that turn, so a fold
 * can only ever mutate the bubble of the turn it is folding. The id is
 * pre-minted by `runChatTurn` and handed over on `assistant-placeholder`, so
 * every streaming mutation targets that bubble by id instead of scanning for
 * `m.streaming`. Cleared on `finalised` / `error`.
 */
export interface StreamTarget {
  messageId: ChatMessageId | null
}

/*
 * Each function below answers the next thread, and the same array when nothing
 * changes, so assigning the result to a reactive list is a no-op then.
 */

export function streamingIndex(messages: ChatMessage[], target: StreamTarget): number {
  if (target.messageId === null) return -1
  return messages.findIndex((m) => m.id === target.messageId)
}

/** Release the target and drop its bubble while it is still a placeholder. */
export function dropStreamingPlaceholder(
  messages: ChatMessage[],
  target: StreamTarget
): ChatMessage[] {
  const id = target.messageId
  target.messageId = null
  if (id === null) return messages
  return messages.filter((m) => !(m.id === id && m.streaming))
}

/**
 * Show a "thinking" placeholder for an in-flight turn when its session is
 * (re)opened, so returning to a session whose answer is still generating shows
 * the streaming indicator instead of an empty thread. Idempotent.
 *
 * `target` is the fold that owns this turn and is claimed even when the bubble
 * is already on screen — a reopened session must hand the running fold its
 * bubble back. Pass nothing when the caller merely wants the bubble drawn.
 */
export function ensureThinkingPlaceholder(
  messages: ChatMessage[],
  sessionId: string,
  assistantMessageId: string,
  nowMs: number,
  target?: StreamTarget
): ChatMessage[] {
  if (target) target.messageId = assistantMessageId as ChatMessageId
  if (messages.some((m) => m.id === assistantMessageId)) return messages
  return [
    ...messages,
    {
      id: assistantMessageId as ChatMessageId,
      sessionId: sessionId as ChatSessionId,
      role: "assistant",
      content: "",
      createdAt: nowMs,
      streaming: true,
    },
  ]
}

/**
 * Blank a bubble back to "thinking" so a replay can rebuild it where it
 * already sits. The replay re-folds the whole answer, so partial prose left by
 * a dropped stream has to go or the deltas double it; keeping the slot
 * preserves the turn's position in a thread that has since gained a newer
 * question.
 */
export function resetBubbleForReplay(
  messages: ChatMessage[],
  assistantMessageId: string
): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === assistantMessageId)
  if (idx < 0) return messages
  const next = [...messages]
  next[idx] = {
    ...next[idx],
    content: "",
    streaming: true,
    error: undefined,
    statusKey: undefined,
    statusParams: undefined,
    researchQuestions: undefined,
    researchSources: undefined,
  }
  return next
}

/**
 * Leave the user a way forward on a turn no answer is coming for: the bubble
 * becomes `failed` (Retry CTA and "connection dropped" copy) when nothing
 * streamed, or `truncated` when partial prose landed — that variant keeps the
 * text and offers Retry in the actions row.
 */
export function abandonBubble(
  messages: ChatMessage[],
  assistantMessageId: string,
  target?: StreamTarget
): ChatMessage[] {
  const idx = messages.findIndex((m) => m.id === assistantMessageId)
  if (idx < 0) return messages
  if (target?.messageId === assistantMessageId) target.messageId = null
  const prev = messages[idx]
  const error: ChatMessageError =
    prev.content.length > 0
      ? { kind: "truncated", reason: "stream" }
      : { kind: "failed", code: "stream" }
  const next = [...messages]
  next[idx] = {
    ...prev,
    streaming: false,
    statusKey: undefined,
    statusParams: undefined,
    researchQuestions: undefined,
    researchSources: undefined,
    error,
  }
  return next
}
