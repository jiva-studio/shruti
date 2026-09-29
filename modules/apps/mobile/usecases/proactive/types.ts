import type { HolidayEntry, ProactiveRuleConfig, ProactiveRuleId } from "@lib/domain/config.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { ChatActionPayload, ChatCiteSnippet } from "@lib/domain/chatMessage.js"
import type { IChatSessionRepository } from "@lib/domain/ports/chatSessionRepository.js"
import type { IDailyWisdomRepository } from "@lib/domain/ports/dailyWisdomRepository.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type {
  IProactiveStateRepository,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"
import type { ISourceRepository } from "@lib/domain/ports/sourceRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { IProactiveChatService } from "@lib/contracts"
import type { NotificationCandidate } from "./notificationPlanner.js"

/** Looks up UI copy in the app language. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** The repositories the rules and the scheduler read and write. */
export interface ProactiveRepositories {
  readonly tracks: ITrackRepository
  readonly sources: ISourceRepository
  readonly listeningSessions: IListeningSessionRepository
  readonly dailyWisdom: IDailyWisdomRepository
  readonly proactiveState: IProactiveStateRepository
  readonly chatSessions: IChatSessionRepository
  readonly unitOfWork: IUnitOfWork
}

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
  /** Whether the user turned on daily engagement (settings.notificationsEnabled).
   *  The daily-wisdom rule gates on this so a silent wisdom still posts to chat
   *  when the toggle is on even if the OS permission was denied. */
  readonly notificationsEnabled: boolean
  readonly isSubscribed: boolean
  readonly totalListenedSeconds: number
  readonly currentStreak: number
  readonly completedTracks: number
  /** Unix-ms of when the device first ran the scheduler. */
  readonly firstSeenAtMs: number | null
  /** Composes body_md in the user's locale. */
  readonly t: Translate
  /** Repositories resolved once per tick. */
  readonly repos: ProactiveRepositories
  /** Backend HTTP client for `kind=proactive` SSE turns. Bound via
   *  port so rules don't import infra directly. */
  readonly proactiveChat: IProactiveChatService
  /** The user's chosen library (lecture content) languages — the same set
   *  that filters lectures everywhere. The daily-wisdom rule restricts its
   *  fragment to these so it never delivers an excerpt in a language the
   *  user doesn't read. Empty = no filter (deliver any language). */
  readonly libraryLanguages: readonly LanguageCode[]
  /** A fresh unique id for a row or a session a rule mints. */
  readonly newId: () => string
  /** Uniform in [0, 1): the daily-wisdom draw. */
  readonly random: () => number
  /** The holiday calendar from the published remote config; empty when unreadable. */
  readonly holidayCalendar: () => Promise<readonly HolidayEntry[]>
}

/**
 * What a detector emits when it decides a rule should fire. `ruleDate`
 * is the dedup key — `(ruleKind, ruleDate)` is UNIQUE so emitting the
 * same instance again is a safe no-op.
 *
 * `visibleAt` is the unified unix-seconds moment: the row appears in
 * chat at that instant and (if `notify=true`) the OS fires a
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
   *
   * `config` is the resolved rule config for this handler so detectors
   * can read tunables (e.g. `prep_window_hours`) from the published
   * catalog instead of hardcoding magic constants.
   */
  detect(ctx: ProactiveContext, config: ProactiveRuleConfig): Promise<readonly DetectResult[]>

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
    /** Transcript snippets for `[cite:…]` markers the body embeds, keyed
     *  `"<trackId>|<startMs>-<endMs>"`. A client-side rule (daily wisdom)
     *  has no server to stream these, so it pre-seeds them here — without
     *  it the marker degrades to a chip whose server-cut excerpt 404s. */
    readonly cites?: Record<string, ChatCiteSnippet>
  } | null>

  /**
   * Optional pre-pause hook for rules that schedule future
   * notifications speculatively (currently only `inactivity`).
   */
  onAppPause?(ctx: ProactiveContext): Promise<void>

  /**
   * Surface the engagement push(es) this rule would like to fire for a
   * given row. The notification planner gathers these across all rules
   * (plus the daily reminder) and keeps only one per local day by
   * priority — rules do not schedule OS pushes themselves.
   *
   * `phase` is `"foreground"` during a tick (user is present) and
   * `"background"` from `onAppPause`. Away-only rules (inactivity) return
   * `[]` in the foreground; the planner cancels their alarms when the
   * user comes back and they're absent from the desired set.
   *
   * The `title` may be left empty for proactive (session-backed) kinds —
   * the planner resolves the chat session's title before arbitration,
   * since it has async repo access.
   */
  collectNotifications?(
    entry: ProactiveStateEntry,
    ctx: ProactiveContext,
    phase: "foreground" | "background"
  ): NotificationCandidate[]
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

/** A proactive lifecycle signal; the composition root's bus carries it to subscribers. */
export type ProactiveEvent =
  | "tick-ready"
  | "row-created"
  | "row-prepped"
  | "replan"
  | "tick-settled"
