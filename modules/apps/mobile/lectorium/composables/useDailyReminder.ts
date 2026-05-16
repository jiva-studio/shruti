import type { INotificationScheduler } from "@ports/app/notifications.js"

const NOTIFICATION_ID = 9001

interface Deps {
  readonly notifications: INotificationScheduler
}

interface State {
  enabled: boolean
  /** "HH:mm" — 24h local time. */
  time: string
  /** Localized copy — caller resolves via i18n so this module stays Vue-free. */
  title: string
  body: string
}

/**
 * Reconciles the platform scheduler with the Settings toggles. We keep a
 * single daily notification id so flipping the toggle off + on doesn't
 * leave stragglers behind.
 *
 * Uses the `every: "day"` recurrence so the OS keeps re-arming the alarm
 * on its own — previously a one-shot `at` schedule worked on iOS (calendar
 * triggers handle recurrence natively) but stopped firing on Android
 * after the first occurrence unless the user opened the app. The plugin's
 * boot receiver carries the recurring alarm across reboots.
 */
export async function applyDailyReminder(state: State, deps: Deps): Promise<void> {
  await deps.notifications.cancel(NOTIFICATION_ID)
  if (!state.enabled) return
  const at = nextOccurrence(state.time)
  if (at === null) return
  const permission = await deps.notifications.requestPermission()
  if (permission === "denied") {
    // Don't silently swallow — without surfacing this the toggle reads as
    // ON in Settings but no notification ever fires. The Settings UI
    // can grow a banner later; for now this is the only signal.
    console.warn(
      "[daily-reminder] cannot schedule — notification permission denied. " +
        "Enable notifications in system settings to receive reminders."
    )
    return
  }
  await deps.notifications.schedule({
    id: NOTIFICATION_ID,
    title: state.title,
    body: state.body,
    at,
    every: "day",
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
