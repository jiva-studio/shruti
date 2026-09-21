import type { Ref } from "vue"
import type { useShruti } from "@shruti/shruti.js"
import {
  arbitrate,
  collectDailyCandidates,
  reconcile,
  type NotificationCandidate,
} from "@shruti/proactive/notificationPlanner.js"
import type { ProactiveContext, ResolvedProactiveRule } from "@shruti/proactive/types.js"
import type { ProactiveStateEntry } from "@lib/domain/ports/proactiveStateRepository.js"
import { formatHourMinute } from "@shruti/composables/proactiveClock.js"

type Shruti = ReturnType<typeof useShruti>

/** How many days ahead the rolling daily reminder is pre-armed. Re-armed each
 *  tick, so the OS always holds ~2 weeks even if the app isn't opened. */
const DAILY_HORIZON_DAYS = 14
/** The legacy recurring daily-reminder id, cancelled once as a migration. */
const LEGACY_DAILY_NOTIFICATION_ID = 9001

export interface PlannerRunDeps {
  readonly app: Pick<Shruti, "repositories" | "notifications">
  readonly t: (key: string, params?: Record<string, unknown>) => string
  readonly dailyEnabled: Ref<boolean>
  readonly dailyTime: Ref<[number, number] | undefined>
}

export type RunPlanner = (
  ctx: ProactiveContext,
  rules: readonly ResolvedProactiveRule[],
  phase: "foreground" | "background"
) => Promise<void>

/**
 * Single arbiter run: gathers candidate pushes from every live proactive row
 * plus the daily reminder, keeps ONE per local day by priority, and reconciles
 * the OS scheduler to exactly that set.
 *
 * `phase` is `"foreground"` from a tick (user present → inactivity pushes
 * suppressed) and `"background"` from `onAppPause`.
 */
export function createProactivePlannerRun(deps: PlannerRunDeps): RunPlanner {
  /** Notification ids the planner owns → the signature each was last scheduled
   *  with, so `reconcile` can skip an unchanged push and cancel a dropped one. */
  const managed = new Map<number, string>()
  let legacyDailyCancelled = false

  /** The planner now owns the daily reminder via per-date rolling ids; cancel
   *  the old `every:"day"` alarm once so it doesn't double-fire. */
  async function migrateLegacyDailyAlarm(): Promise<void> {
    if (legacyDailyCancelled) return
    legacyDailyCancelled = true
    try {
      await deps.app.notifications.cancel(LEGACY_DAILY_NOTIFICATION_ID)
    } catch (err) {
      console.warn("[notify-planner] legacy daily cancel failed", err)
    }
  }

  /**
   * Proactive (session-backed) candidates leave `title` empty so the planner —
   * which has async repo access — resolves the chat session's title, falling
   * back to the app name.
   */
  async function withResolvedTitle(
    candidate: NotificationCandidate,
    entry: ProactiveStateEntry
  ): Promise<NotificationCandidate> {
    if (candidate.title !== "") return candidate
    const session = await deps.app.repositories().chatSessions.getById(entry.sessionId)
    return { ...candidate, title: session?.title?.trim() || deps.t("app.name") }
  }

  async function collectFrom(
    entry: ProactiveStateEntry,
    rule: ResolvedProactiveRule | undefined,
    ctx: ProactiveContext,
    phase: "foreground" | "background"
  ): Promise<NotificationCandidate[]> {
    const collect = rule?.handler.collectNotifications
    if (!collect) return []
    try {
      const produced = collect(entry, ctx, phase)
      return await Promise.all(produced.map((c) => withResolvedTitle(c, entry)))
    } catch (err) {
      console.warn("[notify-planner] collect threw", entry.ruleKind, err)
      return []
    }
  }

  function logRun(
    phase: string,
    candidates: readonly NotificationCandidate[],
    winners: readonly NotificationCandidate[]
  ): void {
    const byKind = new Map<string, number>()
    for (const w of winners) byKind.set(w.kind, (byKind.get(w.kind) ?? 0) + 1)
    console.info(
      "[notify-planner]",
      `phase=${phase}`,
      `candidates=${candidates.length}`,
      `scheduled=${winners.length}`,
      `won=${[...byKind.entries()].map(([k, n]) => `${k}:${n}`).join(",") || "none"}`
    )
  }

  function proactiveRepo() {
    try {
      return deps.app.repositories().proactiveState
    } catch {
      return null
    }
  }

  return async (ctx, rules, phase) => {
    const repo = proactiveRepo()
    if (!repo) return
    await migrateLegacyDailyAlarm()

    const byRule = new Map<string, ResolvedProactiveRule>()
    for (const rule of rules) byRule.set(rule.config.id, rule)

    const live = await repo.listByPrepStates(["ready", "degraded"])
    const candidates: NotificationCandidate[] = []
    for (const entry of live) {
      candidates.push(...(await collectFrom(entry, byRule.get(entry.ruleKind), ctx, phase)))
    }

    // Daily reminder — a rolling window of per-date candidates.
    candidates.push(
      ...collectDailyCandidates({
        enabled: deps.dailyEnabled.value,
        time: formatHourMinute(deps.dailyTime.value),
        title: deps.t("app.name"),
        body: deps.t("notifications.timeToListen"),
        nowMs: ctx.nowMs,
        horizonDays: DAILY_HORIZON_DAYS,
      })
    )

    const winners = arbitrate(candidates, ctx.nowMs)
    await reconcile(winners, deps.app.notifications, managed)
    logRun(phase, candidates, winners)
  }
}
