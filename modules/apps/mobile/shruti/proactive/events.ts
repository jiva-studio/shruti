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
 *                     This is the moment the badge / per-session dot
 *                     should appear, since `listUnseenSessionIds`
 *                     filters by `prep_state IN ('ready','degraded')`.
 *   - `replan`      — external state that affects the notification
 *                     planner changed (e.g. the daily-reminder Settings
 *                     toggle). The scheduler re-runs a tick so the
 *                     daily push turns on/off promptly.
 *
 * Listeners run synchronously inside emit. Throwing is swallowed
 * per-listener so one buggy subscriber doesn't take the bus down.
 */

export type ProactiveEvent = "tick-ready" | "row-created" | "row-prepped" | "replan"

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
