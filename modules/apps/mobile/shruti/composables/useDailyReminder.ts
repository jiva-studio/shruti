import type { INotificationScheduler } from "@ports/app/notifications.js"
import { emit as emitProactive } from "@shruti/proactive/events.js"

/** The legacy recurring daily-reminder id. Kept only so we can cancel a
 *  straggler left by a previous app version that scheduled an
 *  `every:"day"` alarm here. */
const LEGACY_NOTIFICATION_ID = 9001

interface Deps {
  readonly notifications: INotificationScheduler
}

interface State {
  enabled: boolean
  /** "HH:mm" — 24h local time. */
  time: string
  /** Localized copy — kept for signature compatibility with the Settings
   *  controller. The notification planner now owns the daily reminder and
   *  resolves its own copy from i18n, so these are unused here. */
  title: string
  body: string
}

/**
 * The daily reminder is now owned by the notification planner (see
 * `notificationPlanner.collectDailyCandidates` + `useProactiveScheduler`),
 * which arbitrates ALL engagement pushes so a user never gets the daily
 * push AND an inactivity / holiday push on the same local day.
 *
 * This function no longer schedules anything. On a Settings change it:
 *   1. Cancels the legacy recurring `every:"day"` alarm (id 9001) a
 *      previous app version may have left armed, so it can't double with
 *      the planner's rolling per-date daily ids.
 *   2. Emits `replan` so the scheduler re-runs immediately and the daily
 *      push turns on/off promptly instead of waiting for the next tick.
 *
 * The planner reads `settings.notificationsEnabled` / `notificationsTime`
 * itself, so the enabled/time/copy state is consumed there, not here.
 */
export async function applyDailyReminder(state: State, deps: Deps): Promise<void> {
  void state
  await deps.notifications.cancel(LEGACY_NOTIFICATION_ID).catch(() => undefined)
  emitProactive("replan")
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
