/**
 * Decide when to fire a proactive notification for an event that becomes
 * visible at `visibleAtMs`, evaluated at `nowMs`.
 *
 *  - Future event → fire exactly at `visibleAtMs`.
 *  - Event whose moment already passed but is still *today* (local TZ) →
 *    fire ~5s out, so the user still gets a notification for e.g. a
 *    holiday detected the same morning (the OS needs a beat to accept
 *    the schedule and so the tap doesn't race the row's prep_state).
 *  - Event from a past day → return `null` (skip): we don't want a
 *    notification two weeks after a holiday rolled off.
 *
 * Extracted from useProactiveScheduler so the local-midnight window is
 * unit-testable without the scheduler's IO.
 */
export function resolveProactiveFireTime(visibleAtMs: number, nowMs: number): number | null {
  if (visibleAtMs > nowMs) return visibleAtMs
  const today = new Date(nowMs)
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  const tomorrowMidnight = todayMidnight + 86_400_000
  if (visibleAtMs < todayMidnight || visibleAtMs >= tomorrowMidnight) return null
  return nowMs + 5_000
}
