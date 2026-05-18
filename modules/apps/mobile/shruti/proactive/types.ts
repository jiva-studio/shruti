import type { ProactiveRuleConfig, ProactiveRuleId } from "@lib/domain/config.js"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ProactiveStateEntry } from "@lib/domain/ports/proactiveStateRepository.js"
import type { IProactiveChatService } from "@ports/app/index.js"
import type { AppRepositories } from "@shruti/repositories.js"

/**
 * Snapshot of device-side state every rule's detector / validator /
 * content builder reads from. Captured once at the top of each tick to
 * keep all rule decisions consistent within that tick.
 */
export interface ProactiveContext {
  readonly nowMs: number
  readonly localDate: string // 'YYYY-MM-DD'
  readonly localTime: string // 'HH:mm'
  readonly timezone: string // IANA, e.g. 'Europe/Moscow'
  readonly locale: string // app language code, e.g. 'ru'
  readonly hasNotificationsPermission: boolean
  readonly isSubscribed: boolean
  readonly totalListenedSeconds: number
  readonly currentStreak: number
  readonly completedTracks: number
  /** Unix-ms of when the device first ran the scheduler. */
  readonly firstSeenAtMs: number | null
  /** Bound vue-i18n translator. Handlers use this to compose body_md
   *  in the user's locale without pulling in a Vue dependency. */
  readonly t: (key: string, params?: Record<string, unknown>) => string
  /** Repositories bundle resolved once per tick. Passed to rules so
   *  they don't have to reach into the composition root via
   *  `useShruti()` — keeps handlers framework-free. */
  readonly repos: AppRepositories
  /** Backend HTTP client for `kind=proactive` SSE turns. Bound via
   *  port so rules don't import infra directly. */
  readonly proactiveChat: IProactiveChatService
}

/**
 * What a detector emits when it decides a rule should fire. `ruleDate`
 * is the dedup key — `(ruleKind, ruleDate)` is UNIQUE so emitting the
 * same instance again is a safe no-op.
 *
 * `visibleAt` is the unified unix-seconds moment: the row appears in
 * chat at that instant AND (if `notify=true`) the OS fires a
 * LocalNotification at the same instant. `null` means real-time / no
 * gate (currently only used by silent attachments — autonomous rules
 * always pin a future moment).
 *
 * `templateContext` flows through to the session-title template and to
 * the content builder unchanged (e.g., `{ holiday_name, holiday_date,
 * topic_tags }` for holiday).
 */
export interface DetectResult {
  readonly ruleDate: string
  readonly visibleAt: number | null
  readonly notify: boolean
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
   *
   * `actions` is keyed by the marker's `id=` value; the scheduler
   * writes both `body_md` and the action payload map to the
   * underlying `chat_messages` row in one transaction.
   */
  buildContent(
    entry: ProactiveStateEntry,
    ctx: ProactiveContext
  ): Promise<{
    readonly bodyMd: string
    /** Either typed `ChatActionPayload` (for pre-baked rules that build
     *  their own action map locally) or `unknown` payloads bubbling up
     *  from `IProactiveChatService` (LLM-emitted markers). The scheduler
     *  runs `validateAndScrubActions` to narrow before persistence. */
    readonly actions?: Record<string, ChatActionPayload | unknown>
  } | null>

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
