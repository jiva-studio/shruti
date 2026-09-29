import type { HolidayEntry } from "@lib/domain/config.js"
import { notificationIdFor } from "../notificationId.js"
import { toNotificationPreview } from "../notificationPreview.js"
import { NOTIFICATION_PRIORITY } from "../notificationPlanner.js"
import type { ProactiveRuleHandler } from "../types.js"

const HOLIDAY_NOTIFY_HOUR = 8
const DAY_MS = 86_400_000
const DEFAULT_PREP_WINDOW_HOURS = 48

function parseLocalDate(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number)
  return new Date(y, m - 1, d)
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const a = parseLocalDate(fromYmd).getTime()
  const b = parseLocalDate(toYmd).getTime()
  return Math.round((b - a) / DAY_MS)
}

function localizedName(entry: HolidayEntry, locale: string): string {
  return entry.name[locale] ?? entry.name.en ?? entry.id
}

/**
 * Detect upcoming holidays inside the rule's `prep_window_hours` and
 * emit one DetectResult per holiday. The calendar lives in
 * `config.proactive.calendars.holidays` so adding / removing /
 * shifting a date is a `catalog.publish` away — no app release.
 *
 * Content building delegates to the backend so the LLM can curate a
 * small playlist tagged with the holiday's `topic_tags`.
 */
const handler: ProactiveRuleHandler = {
  id: "holiday",

  async detect(ctx, config) {
    const calendars = await ctx.holidayCalendar()
    if (calendars.length === 0) return []

    const prepWindowHours = config.prep_window_hours || DEFAULT_PREP_WINDOW_HOURS
    const prepWindowDays = Math.floor(prepWindowHours / 24)

    return calendars
      .filter((h) => {
        const delta = daysBetween(ctx.localDate, h.date)
        return delta >= 0 && delta <= prepWindowDays
      })
      .map((h) => {
        // `visibleAt` is the unified moment for both UI appearance and
        // OS push — pin it to 08:00 local on the holiday. We don't show
        // the row at midnight and then push at 08:00; both happen at
        // the same moment.
        const holidayLocal = parseLocalDate(h.date)
        const visibleAtMs = holidayLocal.getTime() + HOLIDAY_NOTIFY_HOUR * 3_600_000
        return {
          ruleDate: h.date,
          visibleAt: Math.floor(visibleAtMs / 1000),
          notify: true,
          sessionTitleOverride: localizedName(h, ctx.locale),
          templateContext: {
            holiday_id: h.id,
            holiday_name: localizedName(h, ctx.locale),
            holiday_date: h.date,
          },
        }
      })
  },

  async validate(entry, ctx) {
    // The holiday hasn't moved; the row remains valid until visible_at
    // passes. Only superseded if the calendar entry was removed
    // (catalog.publish without that holiday).
    const calendars = await ctx.holidayCalendar()
    return calendars.some((h) => h.date === entry.ruleDate)
  },

  collectNotifications(entry) {
    if (!entry.notify || entry.visibleAt === null) return []
    const body = toNotificationPreview(entry.bodyMd)
    if (body === "") return []
    return [
      {
        id: notificationIdFor(entry.chatMessageId),
        fireAtMs: entry.visibleAt * 1000,
        priority: NOTIFICATION_PRIORITY.holiday,
        kind: "holiday",
        title: "",
        body,
        extra: { chatSessionId: entry.sessionId, chatMessageId: entry.chatMessageId },
      },
    ]
  },

  async buildContent(entry, ctx) {
    const calendars = await ctx.holidayCalendar()
    const match = calendars.find((h) => h.date === entry.ruleDate)
    if (!match) return null
    const daysUntil = daysBetween(ctx.localDate, entry.ruleDate)

    return ctx.proactiveChat.run(
      {
        ruleKind: "holiday",
        ruleDate: entry.ruleDate,
        ruleContext: {
          holiday_id: match.id,
          holiday_name: localizedName(match, ctx.locale),
          holiday_date: entry.ruleDate,
          days_until: daysUntil,
        },
      },
      ctx.locale
    )
  },
}

export { handler as holidayRule }
