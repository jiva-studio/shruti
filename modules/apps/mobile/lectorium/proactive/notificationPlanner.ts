import type { INotificationScheduler } from "@ports/app/notifications.js"
import { reportError } from "@lectorium/services/monitoring/reportError.js"
import { notificationIdFor } from "./hash.js"

/**
 * Single arbiter for every engagement local-notification the app fires.
 *
 * Multiple sources used to schedule OS pushes independently — the daily
 * reminder, the inactivity ladder, the unfinished-lecture nudge, holiday
 * and weekly-digest cards. An inactive user with the daily reminder on
 * could collect several pushes on the same day. The planner gathers a
 * flat list of CANDIDATE pushes from every source, keeps at most ONE per
 * local calendar day (the highest-priority one), and reconciles the OS
 * scheduler to exactly that winning set.
 */

/** A push one source would like to fire. Sources produce these; the
 *  planner decides which survive. */
export interface NotificationCandidate {
  readonly id: number
  readonly fireAtMs: number
  readonly priority: number
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly extra?: Record<string, unknown>
}

/** Higher wins when two candidates land on the same local day. */
export const NOTIFICATION_PRIORITY = {
  holiday: 50,
  unfinished_lecture: 40,
  inactivity: 30,
  weekly_digest: 20,
  daily: 10,
} as const

/** Local-calendar-day bucket key for a fire moment — collapses any two
 *  candidates that fall on the same day in the device's timezone. */
function localDayKey(fireAtMs: number): string {
  const d = new Date(fireAtMs)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * PURE. Drop candidates already in the past, bucket the rest by local
 * calendar day, and within each day keep the single highest-priority
 * candidate (tie-break: earliest `fireAtMs`, then `kind` ascending).
 * Returns the winners — one per day — sorted by `fireAtMs`.
 */
export function arbitrate(
  candidates: readonly NotificationCandidate[],
  nowMs: number
): NotificationCandidate[] {
  const byDay = new Map<string, NotificationCandidate>()
  for (const c of candidates) {
    if (c.fireAtMs <= nowMs) continue
    const key = localDayKey(c.fireAtMs)
    const current = byDay.get(key)
    if (current === undefined || beats(c, current)) {
      byDay.set(key, c)
    }
  }
  return [...byDay.values()].sort((a, b) => a.fireAtMs - b.fireAtMs)
}

/** Does `a` win the same-day slot over the incumbent `b`? */
function beats(a: NotificationCandidate, b: NotificationCandidate): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority
  if (a.fireAtMs !== b.fireAtMs) return a.fireAtMs < b.fireAtMs
  return a.kind < b.kind
}

/**
 * Reconcile the OS scheduler to exactly the desired set.
 *
 * `managed` maps every notification id the planner currently owns to the
 * signature it was last scheduled with, so an unchanged candidate isn't
 * re-armed (and re-logged) on every tick. We (re)schedule each desired
 * candidate whose signature changed, cancel every previously-managed id
 * that's no longer desired, and leave `managed` holding exactly the
 * desired ids → signatures.
 */
export async function reconcile(
  desired: readonly NotificationCandidate[],
  notifications: INotificationScheduler,
  managed: Map<number, string>
): Promise<void> {
  const desiredIds = new Set<number>()
  for (const c of desired) {
    desiredIds.add(c.id)
    const signature = `${c.fireAtMs}|${c.title}|${c.body}`
    if (managed.get(c.id) === signature) continue
    try {
      await notifications.schedule({
        id: c.id,
        title: c.title,
        body: c.body,
        at: c.fireAtMs,
        extra: c.extra,
      })
      managed.set(c.id, signature)
    } catch (err) {
      reportError("notify-planner", err)
    }
  }
  for (const id of [...managed.keys()]) {
    if (desiredIds.has(id)) continue
    try {
      await notifications.cancel(id)
    } catch (err) {
      reportError("notify-planner", err)
    }
    managed.delete(id)
  }
}

/** Stable notification id for a given local date's daily reminder. */
function dailyId(isoDate: string): number {
  return notificationIdFor(`daily#${isoDate}`)
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Parse "HH:mm" and resolve the first local moment at/after `from` whose
 * time-of-day matches. Mirrors `useDailyReminder.nextOccurrence` but is
 * reused here to roll the daily reminder forward day by day.
 */
function occurrenceOn(day: Date, hour: number, minute: number): number {
  const target = new Date(day)
  target.setHours(hour, minute, 0, 0)
  return target.getTime()
}

/**
 * Materialize the rolling daily-reminder candidates: one per local day
 * for the next `horizonDays` days at the configured HH:mm (skipping
 * today when its time already passed). Each carries a per-date id so the
 * planner can re-arm the rolling window without a recurring OS alarm.
 */
export function collectDailyCandidates(opts: {
  enabled: boolean
  time: string
  title: string
  body: string
  nowMs: number
  horizonDays: number
}): NotificationCandidate[] {
  if (!opts.enabled) return []
  const match = /^(\d{1,2}):(\d{2})/.exec(opts.time)
  if (!match) return []
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return []

  const out: NotificationCandidate[] = []
  const start = new Date(opts.nowMs)
  for (let i = 0; i < opts.horizonDays; i++) {
    const day = new Date(start)
    day.setDate(day.getDate() + i)
    const fireAtMs = occurrenceOn(day, hour, minute)
    if (fireAtMs <= opts.nowMs) continue
    const iso = isoDay(day)
    out.push({
      id: dailyId(iso),
      fireAtMs,
      priority: NOTIFICATION_PRIORITY.daily,
      kind: "daily",
      title: opts.title,
      body: opts.body,
    })
  }
  return out
}
