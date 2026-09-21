import type { Ref } from "vue"
import type { RunChatTurnEvent } from "@usecases"
import type { ChatActionPayload, ChatMessageError } from "@lib/domain"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import { applyStreamingTurnEvent } from "@shruti/stores/chatTurnReducer.js"
import type { ChatMessage, ChatSession } from "./chatTypes.js"
import { randomId, streamingIndex, type StreamTarget } from "./chatBubbles.js"
import { parseQuotaTier } from "./chatUsageSnapshot.js"
import { BARE_RATE_LIMIT_LOCKOUT_MS, type ChatComposeLock } from "./useChatComposeLock.js"
import type { ChatUsageChip } from "./useChatUsageChip.js"

export interface ChatTurnFoldDeps {
  messages: Ref<ChatMessage[]>
  sessions: Ref<ChatSession[]>
  activeSessionId: Ref<string | null>
  usage: ChatUsageChip
  composeLock: ChatComposeLock
  /** Ids of the pair an in-flight Retry is replacing, consumed by the `user-message` event. */
  takeRetryReplacing: () => ReadonlySet<string> | null
  recordInlineHintCooldown: (chatMessageId: string, payload: ChatActionPayload) => Promise<void>
}

export interface ChatTurnFold {
  reflectTurnEvent: (event: RunChatTurnEvent, sessionId: string, target: StreamTarget) => void
  applyTurnEvent: (event: RunChatTurnEvent, target: StreamTarget) => void
}

/**
 * Folds one turn's events into the on-screen thread: the lifecycle cases that
 * touch sessions, usage and error state. The streaming-accumulation cases are
 * `applyStreamingTurnEvent`'s.
 */
export function createChatTurnFold(deps: ChatTurnFoldDeps): ChatTurnFold {
  const { messages, sessions, activeSessionId, usage, composeLock } = deps

  /**
   * Reflect ONE turn event from `runChatTurn` — shared by the live consume
   * loop and the resume replay so the two can't diverge.
   *
   * Applies ONLY to the session currently on screen. A turn that finishes
   * while the user is elsewhere (live switch-away OR a cold-start resume)
   * still persists its verse/cite/chapter/commentary cards via `runChatTurn`
   * → `messages.create` (keyed to that turn's own session), so reopening the
   * session loads them from SQLite — there is nothing to render off-screen.
   * Reflecting an off-screen turn here would be actively wrong: the card
   * cases write into the bubble `target` names, so an off-screen turn's card
   * would land in the conversation the user is looking at.
   *
   * `target` is the caller's own (see `StreamTarget`) — the live loop's or
   * the replay's — never a store-wide one, so two folds racing in the same
   * session write to their own bubbles instead of fighting over one.
   */
  function reflectTurnEvent(
    event: RunChatTurnEvent,
    sessionId: string,
    target: StreamTarget
  ): void {
    if (activeSessionId.value === sessionId) applyTurnEvent(event, target)
  }

  function applyTurnEvent(event: RunChatTurnEvent, target: StreamTarget): void {
    // Streaming-accumulation events (prose deltas, status/research chips, and
    // the per-message card maps) only mutate this fold's streaming bubble —
    // delegated to `applyStreamingTurnEvent`. The lifecycle cases below touch
    // broader store state (sessions, usage, notifications) and stay here.
    if (applyStreamingTurnEvent(event, messages, () => streamingIndex(messages, target))) return
    switch (event.kind) {
      case "user-message":
        return applyUserMessage(event.message)
      case "assistant-placeholder":
        return applyPlaceholder(event.messageId, target)
      case "finalised":
        return applyFinalised(event.message, target)
      case "usage":
        return usage.record(event)
      case "title-updated":
        return applyTitle(event.title)
      case "error":
        return applyTurnError(event, target)
    }
  }

  function applyUserMessage(message: ChatMessage): void {
    // One write: the turn a Retry is replacing goes out in the same assignment
    // that brings the new prompt in, so the thread is never rendered without
    // either of them.
    const replacing = deps.takeRetryReplacing()
    const base = replacing ? messages.value.filter((m) => !replacing.has(m.id)) : messages.value
    messages.value = [...base, message]
  }

  function applyPlaceholder(messageId: ChatMessageId, target: StreamTarget): void {
    target.messageId = messageId
    // A thinking placeholder may already be on screen — `ensureThinkingPlaceholder`
    // adds one when the session is reopened mid-turn.
    if (messages.value.some((m) => m.id === messageId)) return
    messages.value = [
      ...messages.value,
      {
        id: messageId,
        sessionId: (activeSessionId.value ?? "") as ChatSessionId,
        role: "assistant",
        content: "",
        createdAt: Date.now(),
        streaming: true,
      },
    ]
  }

  /**
   * Replace the streaming placeholder with the persisted entity. The
   * turn-settled lifecycle (notification, toast, unread badge, resume cleanup)
   * is emitted from the consume loop instead: this runs only for the on-screen
   * session, but the answer must notify even when the user navigated away.
   */
  function applyFinalised(message: ChatMessage, target: StreamTarget): void {
    const idx = streamingIndex(messages, target)
    target.messageId = null
    if (idx < 0) {
      messages.value = [...messages.value, { ...message }]
    } else {
      const next = [...messages.value]
      next[idx] = { ...message }
      messages.value = next
    }
    // The sidecar is attached only once the chat_message exists: recorded on
    // the `action` event its FK would point at a row that a stream aborting
    // before `finalised` never creates.
    for (const action of Object.values(message.actions ?? {})) {
      void deps.recordInlineHintCooldown(message.id, action)
    }
  }

  function applyTitle(title: string): void {
    const sid = activeSessionId.value
    if (!sid) return
    const i = sessions.value.findIndex((s) => s.id === sid)
    if (i < 0) return
    const next = [...sessions.value]
    next[i] = { ...next[i], title }
    sessions.value = next
  }

  /**
   * Terminal lifecycle (resume cleanup and the settle signal) is emitted from
   * the consume loop, not here — this fold is view-gated, but a failure must
   * clear the pending record app-wide.
   */
  function applyTurnError(
    event: Extract<RunChatTurnEvent, { kind: "error" }>,
    target: StreamTarget
  ): void {
    // A user stop with no prose yet: drop the placeholder silently rather than
    // leave a failed bubble suggesting something went wrong. Stops with prose
    // are persisted through `finalised` with meta.error.kind="stopped".
    if (event.code === "stopped_empty") {
      const stoppedId = target.messageId
      target.messageId = null
      messages.value = messages.value.filter((m) => m.id !== stoppedId)
      return
    }
    const retryAfterAt = retryDeadlineFor(event)
    const tier = parseQuotaTier(event.tier)
    const failedErr: ChatMessageError = {
      kind: "failed",
      code: event.code,
      ...(retryAfterAt !== undefined ? { retryAfterAt } : {}),
      ...(tier !== undefined ? { tier } : {}),
    }
    // Only quota errors lock the composer; network and server errors stay
    // retryable.
    if (event.code === "rate_limited" && retryAfterAt) {
      composeLock.applyRateLimit({
        retryAfterAt,
        tier: event.tier,
        keyType: event.keyType,
        current: event.current,
        limit: event.limit,
        resetsAtEpoch: event.resetsAtEpoch,
      })
    }
    showFailedBubble(failedErr, target)
  }

  /**
   * Everything reading `retryAfterAt` compares it against the DEVICE clock, so
   * the deadline is built on the device clock out of a duration the server
   * measured. The absolute `resets_at_epoch` is the fallback: a skewed device
   * reads it skewed, but substituting a number of our own is strictly worse.
   */
  function retryDeadlineFor(
    event: Extract<RunChatTurnEvent, { kind: "error" }>
  ): number | undefined {
    if (typeof event.retryAfter === "number" && event.retryAfter > 0) {
      return Date.now() + event.retryAfter * 1000
    }
    if (typeof event.resetsAtEpoch === "number" && event.resetsAtEpoch > 0) {
      return event.resetsAtEpoch * 1000
    }
    return event.code === "rate_limited" ? Date.now() + BARE_RATE_LIMIT_LOCKOUT_MS : undefined
  }

  /**
   * Transform the streaming placeholder into a failed bubble in place, keeping
   * the message id stable. Failed bubbles stay in memory only: the SQL
   * `parseError` whitelist would discard the `failed` kind on reload anyway.
   */
  function showFailedBubble(failedErr: ChatMessageError, target: StreamTarget): void {
    const idx = streamingIndex(messages, target)
    target.messageId = null
    if (idx < 0) {
      // The error fired before `assistant-placeholder` — the pre-stream fetch
      // itself failed. Synthesize a row so the failure is still attached to
      // the turn the user just sent.
      messages.value = [
        ...messages.value,
        {
          id: randomId() as ChatMessageId,
          sessionId: (activeSessionId.value ?? "") as ChatSessionId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          error: failedErr,
        },
      ]
      return
    }
    const next = [...messages.value]
    next[idx] = {
      ...next[idx],
      streaming: false,
      content: "",
      statusKey: undefined,
      statusParams: undefined,
      error: failedErr,
    }
    messages.value = next
  }

  return { reflectTurnEvent, applyTurnEvent }
}
