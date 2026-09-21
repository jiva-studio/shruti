import { notificationIdFor } from "../hash.js"
import { toNotificationPreview } from "../notificationPreview.js"
import { NOTIFICATION_PRIORITY } from "../notificationPlanner.js"
import type { ProactiveRuleHandler } from "../types.js"
import { registerRule } from "../registry.js"

const DEFAULT_PREP_WINDOW_HOURS = 12
const MONDAY_NOTIFY_HOUR = 9

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
 * The next Monday at/after `now`'s notify hour. The digest fires on
 * Monday morning so it recaps a *finished* week (the previous Mon–Sun) —
 * a Sunday digest would land while the week is still running. When today IS
 * Monday the target is today, so a user who only opens the app on Monday
 * mornings still receives one and the detector's "already past" guard has
 * something to reject.
 */
export function nextMondayFrom(now: Date): Date {
  const day = now.getDay() // 0=Sunday … 6=Saturday
  // On a Monday the target is TODAY, whatever the hour. Rolling to next week
  // at the notify hour put the target a week out — past any prep window — so
  // the detector's grace hour could never run and 09:00 itself emitted
  // nothing. Whether the moment has gone is the detector's to decide.
  // 0(Sun)→1, 2(Tue)→6, 3→5, 4→4, 5→3, 6(Sat)→2.
  const daysToMonday = day === 1 ? 0 : (8 - day) % 7
  const monday = startOfDay(now)
  monday.setDate(monday.getDate() + daysToMonday)
  return monday
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
 * Monday-morning recap of the *previous* (finished) week — the seven
 * days Mon–Sun that just ended. Detector waits until we are within 12
 * hours of the upcoming Monday 09:00 so the data we collect is fresh;
 * cooldown of 144 h keeps us to one digest per week.
 *
 * The detector itself doesn't compose the body — it just inserts the
 * row. `buildContent` prepends a localised intro line and emits a single
 * deterministic `[digest:from-to]` marker (no LLM); `WeeklyDigestCard.vue`
 * fetches the recap data for the window and renders the chart + lecture
 * list + summary badges.
 */
const handler: ProactiveRuleHandler = {
  id: "weekly_digest",

  async detect(ctx, config) {
    const now = new Date(ctx.nowMs)
    const monday = nextMondayFrom(now)
    const visibleAtMs = monday.getTime() + MONDAY_NOTIFY_HOUR * 3_600_000
    const msUntil = visibleAtMs - ctx.nowMs
    const prepWindowHours = config.prep_window_hours || DEFAULT_PREP_WINDOW_HOURS
    if (msUntil > prepWindowHours * 3_600_000) return []
    if (msUntil < -3_600_000) return [] // already past — don't backfill

    // The recapped week is the one that just finished: previous Monday
    // (7 days back) through the Sunday right before this Monday.
    const weekStart = new Date(monday.getTime() - 7 * 86_400_000)
    const weekEnd = new Date(monday.getTime() - 86_400_000)
    return [
      {
        ruleDate: formatYmd(monday),
        visibleAt: Math.floor(visibleAtMs / 1000),
        notify: true,
        // Localised session header — the override beats any (English)
        // `session_title_template` in the published config, so the digest
        // title follows the user's app language like every other rule.
        sessionTitleOverride: ctx.t("chat.proactiveSessionTitleWeeklyDigest"),
        templateContext: {
          week_label: weekLabel(weekStart, weekEnd, ctx.locale),
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

  async buildContent(entry, ctx) {
    // The finished week ending at the proactive message's rule_date
    // (Monday 00:00 local): the 7 days [prev Monday, this Monday). The
    // card (`WeeklyDigestCard.vue`) loads the recap itself from this
    // window — the rule just emits the marker, no LLM and no client-side
    // aggregation here.
    const mondayLocal = new Date(`${entry.ruleDate}T00:00:00`).getTime()
    const fromMs = mondayLocal - 7 * 86_400_000
    const toMs = mondayLocal

    // A localised intro line precedes the widget: it reads as a friendly
    // lead-in above the card in chat AND is what `toNotificationPreview`
    // surfaces as the OS push body (the `[digest:…]` marker is stripped
    // there). No LLM — the copy lives in i18n.
    const intro = ctx.t("chat.weeklyDigestIntro")
    return { bodyMd: `${intro}\n\n[digest:${fromMs}-${toMs}]` }
  },
}

registerRule(handler)
