import type { Ref } from "vue"
import type { ChatMessageId, ChatSessionId } from "@lib/domain/core.js"
import type { PendingTurn } from "@lectorium/stores/chatPendingTurns.js"
import { emitTurnSettled } from "@lectorium/chat/turnNotificationEvents.js"
import type { ChatMessage } from "./chatTypes.js"
import { ensureThinkingPlaceholder, type StreamTarget } from "./chatBubbles.js"

/** One live turn in flight, shared by the consume loop and the settle path. */
export interface LiveTurn {
  sessionId: ChatSessionId
  target: StreamTarget
  assistantMsgId: ChatMessageId | null
  /** The socket died but the server has the turn buffered — recover by resume, don't fail. */
  resumableDrop: boolean
  /** A lifecycle event already settled this turn. */
  settled: boolean
  /** The pending-record write; the settle path joins it before removing the record. */
  pendingWrite: Promise<void>
}

export interface SettleDeps {
  messages: Ref<ChatMessage[]>
  sending: Ref<boolean>
  activeSessionId: Ref<string | null>
  turnControllers: Map<string, AbortController>
  liveTargets: Map<string, StreamTarget>
  readPending: () => Promise<PendingTurn[]>
  removePending: (assistantMessageId: string) => Promise<void>
  resumeOnePendingTurn: (entry: PendingTurn) => Promise<void>
}

export async function settleLiveTurn(
  turn: LiveTurn,
  controller: AbortController,
  deps: SettleDeps
): Promise<void> {
  // Deregister only our own: a newer turn for the same session (after a detach
  // and return) may have replaced it.
  if (deps.turnControllers.get(turn.sessionId) === controller) {
    deps.turnControllers.delete(turn.sessionId)
  }
  if (deps.liveTargets.get(turn.sessionId) === turn.target) {
    deps.liveTargets.delete(turn.sessionId)
  }
  // Only the turn whose session is still on screen owns the shared compose
  // state; a detached turn finishing later must not flip it.
  if (deps.activeSessionId.value === turn.sessionId) deps.sending.value = false

  if (turn.resumableDrop && turn.assistantMsgId) await recoverDroppedTurn(turn, deps)
  else if (turn.assistantMsgId) dropAbandonedPlaceholder(turn, deps)
  await settlePendingRecord(turn, deps)
}

/** Hand the turn to the resume poll, which replays the answer the server buffered. */
async function recoverDroppedTurn(turn: LiveTurn, deps: SettleDeps): Promise<void> {
  const assistantMessageId = turn.assistantMsgId as ChatMessageId
  if (deps.activeSessionId.value === turn.sessionId) {
    // View-only: the resume poll mints the target owning this bubble now.
    ensureThinkingPlaceholder(deps.messages, turn.sessionId, assistantMessageId)
  }
  // Prefer the persisted entry for its real createdAt (the TTL), but
  // synthesize one if `addPending` hasn't flushed — the server buffer is keyed
  // by the message id, so resume works either way.
  const entry = (await deps.readPending()).find(
    (p) => p.assistantMessageId === assistantMessageId
  ) ?? {
    assistantMessageId,
    sessionId: turn.sessionId,
    createdAt: Date.now(),
  }
  void deps.resumeOnePendingTurn(entry)
}

/**
 * Abort path only: `chatClient` swallows AbortError, so no `error` event
 * reached the fold and the placeholder is still streaming. A real error left a
 * failed bubble with `streaming` cleared, which this skips.
 */
function dropAbandonedPlaceholder(turn: LiveTurn, deps: SettleDeps): void {
  const { messages } = deps
  const idx = messages.value.findIndex((m) => m.id === turn.assistantMsgId)
  if (idx >= 0 && messages.value[idx].streaming) {
    messages.value = messages.value.filter((m) => m.id !== turn.assistantMsgId)
  }
  // Drop this fold's handle so a stray late event can't reattach to a bubble
  // that is no longer streaming.
  if (turn.target.messageId === turn.assistantMsgId) turn.target.messageId = null
}

/**
 * A turn that died by exception or abort yields neither `finalised` nor
 * `error`, so nothing cleared its pending record — and a stranded record is
 * not inert: `openSession` re-raises a thinking placeholder from it for its
 * whole TTL, and every backgrounding re-arms its "Sadhu replied" notification.
 */
async function settlePendingRecord(turn: LiveTurn, deps: SettleDeps): Promise<void> {
  if (!turn.assistantMsgId || turn.resumableDrop || turn.settled) return
  // The record write is fire-and-forget so it can't delay the stream, but a
  // removal in the same tick would otherwise miss a write that hasn't landed.
  await turn.pendingWrite.catch(() => undefined)
  await deps.removePending(turn.assistantMsgId)
  emitTurnSettled({
    assistantMessageId: turn.assistantMsgId,
    sessionId: turn.sessionId,
    ok: false,
  })
}
