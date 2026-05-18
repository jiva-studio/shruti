import { useLectorium } from "@lectorium/lectorium.js"
import { runProactiveTurn } from "../proactiveChat.js"
import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

const PREP_WINDOW_HOURS = 12
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

function nextSundayFrom(now: Date): Date {
  const day = now.getDay() // 0=Sunday … 6=Saturday
  const daysToSunday = day === 0 ? 7 : 7 - day
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
 * row. `buildContent` runs the proactive `/chat` turn and returns the
 * markdown when the next tick picks the row up.
 */
const handler: ProactiveRuleHandler = {
  id: "weekly_digest",

  async detect(ctx) {
    const now = new Date(ctx.nowMs)
    const sunday = nextSundayFrom(now)
    const notifyAtMs = sunday.getTime() + SUNDAY_NOTIFY_HOUR * 3_600_000
    const msUntil = notifyAtMs - ctx.nowMs
    if (msUntil > PREP_WINDOW_HOURS * 3_600_000) return []
    if (msUntil < -3_600_000) return [] // already past — don't backfill

    return [
      {
        ruleDate: formatYmd(sunday),
        visibleOn: formatYmd(sunday),
        notifyAt: Math.floor(notifyAtMs / 1000),
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

  async buildContent(entry, ctx) {
    const app = useLectorium()
    const repos = app.repositories()

    // 7-day window ending at the proactive message's rule_date.
    const sundayUtc = new Date(`${entry.ruleDate}T00:00:00`).getTime()
    const fromMs = sundayUtc - 6 * 86_400_000
    const toMs = sundayUtc + 86_400_000

    const [dailyTotals, recent] = await Promise.all([
      repos.listeningSessions.getDailyTotals(fromMs, toMs),
      repos.listeningSessions.listRecentTracksWithProgress(20),
    ])
    const totalListenedSeconds = dailyTotals.reduce((acc, d) => acc + d.listenedSeconds, 0)
    const completedTrackIds = recent
      .filter((r) => r.endedAtMs >= fromMs && r.endedAtMs < toMs)
      .map((r) => r.trackId)

    const ruleContext = {
      week_start: formatYmd(new Date(fromMs)),
      week_end: entry.ruleDate,
      total_listened_seconds: totalListenedSeconds,
      completed_track_ids: completedTrackIds,
      current_streak: ctx.currentStreak,
      // top_tags / top_authors aren't aggregated client-side yet;
      // the LLM prompt copes with missing fields. Future work.
      top_tags: [],
      top_authors: [],
    }

    const result = await runProactiveTurn(
      {
        ruleKind: "weekly_digest",
        ruleDate: entry.ruleDate,
        ruleContext,
      },
      ctx.locale.startsWith("en") ? "en" : "ru"
    )
    return result
  },
}

registerRule(handler)
