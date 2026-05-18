import type { ProactiveRuleConfig, ProactiveRuleId } from "@lib/domain/config.js"
import type { ProactiveStateEntry } from "@lib/domain/ports/proactiveStateRepository.js"

/**
 * Snapshot of device-side state every rule's detector / validator /
 * content builder reads from. Captured once at the top of each tick to
 * keep all rule decisions consistent within that tick.
 */
export interface ProactiveContext {
  readonly nowMs: number
  readonly localDate: string                  // 'YYYY-MM-DD'
  readonly localTime: string                  // 'HH:mm'
  readonly timezone: string                   // IANA, e.g. 'Europe/Moscow'
  readonly locale: string                     // app language code, e.g. 'ru'
  readonly hasNotificationsPermission: boolean
  readonly isSubscribed: boolean
  readonly totalListenedSeconds: number
  readonly currentStreak: number
  readonly completedTracks: number
  /** Unix-ms of the oldest listening session, used as install-age proxy. */
  readonly firstSeenAtMs: number | null
}

/**
 * What a detector emits when it decides a rule should fire. `ruleDate`
 * is the dedup key — `(ruleKind, ruleDate)` is UNIQUE so emitting the
 * same instance again is a safe no-op.
 *
 * `templateContext` flows through to the session-title template and to
 * the content builder unchanged (e.g., `{ holiday_name, holiday_date,
 * topic_tags }` for holiday).
 */
export interface DetectResult {
  readonly ruleDate: string
  readonly visibleOn: string | null
  readonly notifyAt: number | null
  readonly sessionTitleOverride?: string
  readonly templateContext: Record<string, unknown>
}

/**
 * Implementation surface for one rule. Detectors are called every tick
 * to surface fresh instances; validators run on every existing pending
 * row to keep stale conditions from sticking; content builders fill the
 * body markdown for `prep_state: 'ready'`.
 */
export interface ProactiveRuleHandler {
  readonly id: ProactiveRuleId

  /**
   * Decide whether this rule has any new instance to emit. Most rules
   * return zero or one — `holiday` can return more than one when
   * multiple holidays fall inside the prep window.
   *
   * The scheduler dedupes via the SQL UNIQUE constraint, so detectors
   * can return the same instance every tick without harm.
   */
  detect(ctx: ProactiveContext): Promise<readonly DetectResult[]>

  /**
   * For a row already in `pending` or `ready`, decide whether the rule
   * is still relevant. `false` → row is marked `superseded` and hidden.
   */
  validate(entry: ProactiveStateEntry, ctx: ProactiveContext): Promise<boolean>

  /**
   * Generate the body markdown (and any inline action markers) for a
   * row that needs prep. Returning `null` keeps the row in `pending`
   * for the next tick. Throwing falls back to `degraded` with whatever
   * body was already there.
   */
  buildContent(
    entry: ProactiveStateEntry,
    ctx: ProactiveContext
  ): Promise<{ readonly bodyMd: string } | null>

  /**
   * Optional pre-pause hook for rules that schedule future
   * notifications speculatively (currently only `inactivity`).
   */
  onAppPause?(ctx: ProactiveContext): Promise<void>
}

/**
 * Resolved rule binding the scheduler iterates on. Pairs the static
 * config (from `RemoteAppConfig.proactive.rules` or bundled fallback)
 * with the imperative handler that drives detect/validate/build.
 */
export interface ResolvedProactiveRule {
  readonly config: ProactiveRuleConfig
  readonly handler: ProactiveRuleHandler
}
