/**
 * Module-level event bus for proactive lifecycle signals. Decouples
 * the scheduler from anyone who wants to react to proactive activity
 * (e.g. the chat store refreshing its session list and unseen set).
 *
 * Why not just have the scheduler call `useChatStore().refreshSessions()`
 * directly? Because that wires the proactive subsystem to a specific
 * UI store, and any other future consumer (telemetry, analytics, a
 * second screen) would have to be plumbed through there too. With a
 * bus the scheduler emits "something happened" and stays oblivious.
 *
 * Three events:
 *   - `tick-ready`  — a scheduler tick is starting and ALL DBs are
 *                     open. Cheap "any external state may have moved"
 *                     hint for subscribers to revalidate.
 *   - `row-created` — a brand-new proactive row was persisted (still
 *                     `pending`; not yet surfaced via
 *                     `listUnseenSessionIds`). Useful for refreshing
 *                     the session list (the row's `chat_sessions`
 *                     entry exists).
 *   - `row-prepped` — a row transitioned to `ready` or `degraded`.
 *                     The badge / per-session dot appears here ONLY for
 *                     rows already past their `visible_at`, since
 *                     `listUnseenSessionIds` gates on
 *                     `prep_state IN ('ready','degraded')` AND
 *                     `visible_at <= now`. A row prepped ahead of its
 *                     visibility moment surfaces on a later refresh
 *                     (tick / resume) once `visible_at` has arrived.
 *   - `replan`      — external state that affects the notification
 *                     planner changed (e.g. the daily-reminder Settings
 *                     toggle). The scheduler re-runs a tick so the
 *                     daily push turns on/off promptly.
 *   - `tick-settled`— a tick finished (emitted in `tick()`'s `finally`,
 *                     so it fires even on an early return / throw).
 *                     Marks the coalescing boundary for "everything that
 *                     surfaced this open": subscribers that would otherwise
 *                     react once per `row-prepped` can instead flush a
 *                     SINGLE grouped reaction here (e.g. one toast for N
 *                     freshly-prepped proactive messages instead of N).
 *
 * Listeners run synchronously inside emit. Throwing is swallowed
 * per-listener so one buggy subscriber doesn't take the bus down.
 */

export type ProactiveEvent =
  | "tick-ready"
  | "row-created"
  | "row-prepped"
  | "replan"
  | "tick-settled"

const listeners = new Map<ProactiveEvent, Set<() => void>>()

export function on(event: ProactiveEvent, fn: () => void): () => void {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
  }
}

export function emit(event: ProactiveEvent): void {
  const set = listeners.get(event)
  if (!set) return
  for (const fn of set) {
    try {
      fn()
    } catch (err) {
      console.warn("[proactive/events]", event, "listener threw:", err)
    }
  }
}
