import { notificationIdFor } from "../hash.js"
import { toNotificationPreview } from "../notificationPreview.js"
import { NOTIFICATION_PRIORITY } from "../notificationPlanner.js"
import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

const DEFAULT_PREP_WINDOW_HOURS = 12
const SUNDAY_NOTIFY_HOUR = 9

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatYmd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

/**
 * The next Sunday at/after `now`'s notify hour. When today IS Sunday
 * and we haven't yet passed the digest's notify hour, target TODAY —
 * otherwise a user who only opens the app on Sunday mornings would
 * always be pushed to next week's Sunday and never receive a digest
 * (and the detector's "already past" guard would be dead code).
 */
export function nextSundayFrom(now: Date): Date {
  const day = now.getDay() // 0=Sunday … 6=Saturday
  let daysToSunday: number
  if (day === 0) {
    // Today is Sunday: keep today if still before the notify hour,
    // otherwise roll to next week.
    daysToSunday = now.getHours() < SUNDAY_NOTIFY_HOUR ? 0 : 7
  } else {
    daysToSunday = 7 - day
  }
  const sunday = startOfDay(now)
  sunday.setDate(sunday.getDate() + daysToSunday)
  return sunday
}

function weekLabel(weekStart: Date, weekEnd: Date, locale: string): string {
  const sameMonth = weekStart.getMonth() === weekEnd.getMonth()
  if (locale === "ru") {
    return sameMonth
      ? `${weekStart.getDate()}–${weekEnd.getDate()}`
      : `${weekStart.getDate()}.${pad(weekStart.getMonth() + 1)}–${weekEnd.getDate()}.${pad(weekEnd.getMonth() + 1)}`
  }
  return sameMonth
    ? `${weekStart.toLocaleString("en", { month: "short" })} ${weekStart.getDate()}–${weekEnd.getDate()}`
    : `${weekStart.toLocaleString("en", { month: "short" })} ${weekStart.getDate()} – ${weekEnd.toLocaleString("en", { month: "short" })} ${weekEnd.getDate()}`
}

/**
 * Sunday-morning recap of the past 7 days. Detector waits until we
 * are within 12 hours of the upcoming Sunday 09:00 so the data we
 * collect is fresh; cooldown of 144 h keeps us to one digest per week.
 *
 * The detector itself doesn't compose the body — it just inserts the
 * row. `buildContent` emits a single deterministic `[digest:from-to]`
 * marker (no LLM); `WeeklyDigestCard.vue` fetches the recap data for the
 * window and renders the chart + lecture list + summary badges.
 */
const handler: ProactiveRuleHandler = {
  id: "weekly_digest",

  async detect(ctx, config) {
    const now = new Date(ctx.nowMs)
    const sunday = nextSundayFrom(now)
    const visibleAtMs = sunday.getTime() + SUNDAY_NOTIFY_HOUR * 3_600_000
    const msUntil = visibleAtMs - ctx.nowMs
    const prepWindowHours = config.prep_window_hours || DEFAULT_PREP_WINDOW_HOURS
    if (msUntil > prepWindowHours * 3_600_000) return []
    if (msUntil < -3_600_000) return [] // already past — don't backfill

    return [
      {
        ruleDate: formatYmd(sunday),
        visibleAt: Math.floor(visibleAtMs / 1000),
        notify: true,
        templateContext: {
          week_label: weekLabel(new Date(sunday.getTime() - 6 * 86_400_000), sunday, ctx.locale),
        },
      },
    ]
  },

  async validate() {
    // Weekly digests are always relevant — even an empty week is worth
    // noting ("you didn't listen this week, here's something fresh").
    return true
  },

  collectNotifications(entry) {
    if (!entry.notify || entry.visibleAt === null) return []
    const body = toNotificationPreview(entry.bodyMd)
    if (body === "") return []
    return [
      {
        id: notificationIdFor(entry.chatMessageId),
        fireAtMs: entry.visibleAt * 1000,
        priority: NOTIFICATION_PRIORITY.weekly_digest,
        kind: "weekly_digest",
        title: "",
        body,
        extra: { chatSessionId: entry.sessionId, chatMessageId: entry.chatMessageId },
      },
    ]
  },

  async buildContent(entry) {
    // 7-day window ending at the proactive message's rule_date. The card
    // (`WeeklyDigestCard.vue`) loads the recap itself from this window —
    // the rule just emits the marker, no LLM and no client-side
    // aggregation here.
    const sundayUtc = new Date(`${entry.ruleDate}T00:00:00`).getTime()
    const fromMs = sundayUtc - 6 * 86_400_000
    const toMs = sundayUtc + 86_400_000

    return { bodyMd: `[digest:${fromMs}-${toMs}]` }
  },
}

registerRule(handler)
