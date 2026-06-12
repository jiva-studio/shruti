/**
 * Module-level bus of "tell the user something" intents. Emitters (chat turns,
 * proactive messages) stay oblivious to HOW it's surfaced — `useUserNotifier`
 * subscribes and decides toast (foreground) vs local notification (background)
 * in ONE place. Same decoupling pattern as the proactive event bus.
 *
 * Listeners run synchronously inside emit; a throwing listener is swallowed so
 * one buggy subscriber can't take the bus down.
 */

export interface NotifyIntent {
  readonly title: string
  readonly body: string
  /** Tap target — the toast button / notification opens this chat session. */
  readonly sessionId?: string
  /** Stable notification id for the background path, so a later schedule /
   *  cancel for the same logical event lines up. */
  readonly notificationId?: number
  /** What to do when the app is NOT in the foreground: schedule an immediate
   *  local notification, or skip (the emitter owns its own background delivery,
   *  e.g. proactive's separately-scheduled notification). */
  readonly whenBackground: "notify" | "skip"
}

const listeners = new Set<(intent: NotifyIntent) => void>()

export function onNotify(fn: (intent: NotifyIntent) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function emitNotify(intent: NotifyIntent): void {
  for (const fn of listeners) {
    try {
      fn(intent)
    } catch (err) {
      console.warn("[notify] listener threw:", err)
    }
  }
}
