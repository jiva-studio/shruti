/**
 * Module-level event bus for chat-turn lifecycle signals. Mirrors the
 * proactive event bus (`shruti/proactive/events.ts`): the chat store
 * emits "a turn started / settled" and stays oblivious to notifications
 * (and to Capacitor). `useChatTurnNotifications` subscribes and owns the
 * "answer ready" local notification — so the dependency arrow points
 * outward (store → composable), never the store importing the scheduler.
 *
 * Listeners run synchronously inside emit; a throwing listener is swallowed
 * so one buggy subscriber can't take the bus down.
 */

export interface TurnStartedEvent {
  readonly assistantMessageId: string
  readonly sessionId: string
}

export interface TurnSettledEvent {
  readonly assistantMessageId: string
  readonly sessionId: string
  /** True only on a successful finalised reply — drives whether an "answer
   *  ready" notification fires (vs merely cancelling the predictive one on
   *  an error / user stop). */
  readonly ok: boolean
}

const startedListeners = new Set<(e: TurnStartedEvent) => void>()
const settledListeners = new Set<(e: TurnSettledEvent) => void>()

export function onTurnStarted(fn: (e: TurnStartedEvent) => void): () => void {
  startedListeners.add(fn)
  return () => {
    startedListeners.delete(fn)
  }
}

export function onTurnSettled(fn: (e: TurnSettledEvent) => void): () => void {
  settledListeners.add(fn)
  return () => {
    settledListeners.delete(fn)
  }
}

export function emitTurnStarted(e: TurnStartedEvent): void {
  for (const fn of startedListeners) {
    try {
      fn(e)
    } catch (err) {
      console.warn("[chat/turnEvents] turn-started listener threw:", err)
    }
  }
}

export function emitTurnSettled(e: TurnSettledEvent): void {
  for (const fn of settledListeners) {
    try {
      fn(e)
    } catch (err) {
      console.warn("[chat/turnEvents] turn-settled listener threw:", err)
    }
  }
}
