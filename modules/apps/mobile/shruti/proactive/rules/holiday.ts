import { useShruti } from "@shruti/shruti.js"
import type { HolidayEntry, RemoteAppConfig } from "@lib/domain/config.js"
import { runProactiveTurn } from "../proactiveChat.js"
import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

const HOLIDAY_NOTIFY_HOUR = 8
const DAY_MS = 86_400_000

function localDate(d: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

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

  async detect(ctx) {
    const calendars = await readHolidayCalendar()
    if (calendars.length === 0) return []

    const prepWindowDays = 2 // mirrors config.prep_window_hours = 48

    return calendars
      .filter((h) => {
        const delta = daysBetween(ctx.localDate, h.date)
        return delta >= 0 && delta <= prepWindowDays
      })
      .map((h) => {
        const holidayLocal = parseLocalDate(h.date)
        const notifyAt = holidayLocal.getTime() + HOLIDAY_NOTIFY_HOUR * 3_600_000
        return {
          ruleDate: h.date,
          visibleOn: h.date,
          notifyAt: Math.floor(notifyAt / 1000),
          sessionTitleOverride: localizedName(h, ctx.locale),
          templateContext: {
            holiday_id: h.id,
            holiday_name: localizedName(h, ctx.locale),
            holiday_date: h.date,
            topic_tags: h.topic_tags,
          },
        }
      })
  },

  async validate(entry, ctx) {
    // The holiday hasn't moved; the row remains valid until visible_on
    // passes. Only superseded if the calendar entry was removed
    // (catalog.publish without that holiday).
    const calendars = await readHolidayCalendar()
    return calendars.some((h) => h.date === entry.ruleDate)
  },

  async buildContent(entry, ctx) {
    const calendars = await readHolidayCalendar()
    const match = calendars.find((h) => h.date === entry.ruleDate)
    if (!match) return null
    const daysUntil = daysBetween(ctx.localDate, entry.ruleDate)

    return runProactiveTurn(
      {
        ruleKind: "holiday",
        ruleDate: entry.ruleDate,
        ruleContext: {
          holiday_id: match.id,
          holiday_name: localizedName(match, ctx.locale),
          holiday_date: entry.ruleDate,
          days_until: daysUntil,
          topic_tags: match.topic_tags,
        },
      },
      ctx.locale.startsWith("en") ? "en" : "ru"
    )
  },
}

async function readHolidayCalendar(): Promise<readonly HolidayEntry[]> {
  const app = useShruti()
  try {
    const configUrl = app.storagePublicUrl.get(app.appConfig.publicRemoteConfigPath)
    const raw = await app.filesStorage.getJson<RemoteAppConfig>(configUrl)
    return raw.proactive?.calendars?.holidays ?? []
  } catch {
    return []
  }
}

registerRule(handler)
