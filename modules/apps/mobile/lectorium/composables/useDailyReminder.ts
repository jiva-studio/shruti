import type { INotificationScheduler } from "@ports/app/notifications.js"

const NOTIFICATION_ID = 9001

interface Deps {
  readonly notifications: INotificationScheduler
}

interface State {
  enabled: boolean
  /** "HH:mm" — 24h local time. */
  time: string
}

/**
 * Reconciles the platform scheduler with the Settings toggles. We keep a
 * single daily notification id so flipping the toggle off + on doesn't
 * leave stragglers behind.
 *
 * The scheduler only supports absolute `at`; we compute the next local
 * occurrence and re-schedule on every `apply()` — called once at Settings
 * mount and again on each state change. A drift-free implementation
 * (proper repeating) would need platform-specific `repeats: true` and
 * a `DateTime.interval`, which the port doesn't cover yet.
 */
export async function applyDailyReminder(state: State, deps: Deps): Promise<void> {
  await deps.notifications.cancel(NOTIFICATION_ID)
  if (!state.enabled) return
  const at = nextOccurrence(state.time)
  if (at === null) return
  const permission = await deps.notifications.requestPermission()
  if (permission === "denied") return
  await deps.notifications.schedule({
    id: NOTIFICATION_ID,
    title: "Lectorium",
    body: "A short lecture break is waiting.",
    at,
  })
}

export function nextOccurrence(time: string, now: Date = new Date()): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(time)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  const target = new Date(now)
  target.setHours(hour, minute, 0, 0)
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1)
  }
  return target.getTime()
}
