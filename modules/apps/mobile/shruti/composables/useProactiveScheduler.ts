import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import type { ProactiveConfig, RemoteAppConfig } from "@lib/domain/config.js"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ChatMessageId } from "@lib/domain/core.js"
import type {
  IProactiveStateRepository,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"
import { getActivityOverview } from "@lib/application/getActivityOverview.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useShruti } from "@shruti/shruti.js"
import { isEligible } from "@shruti/proactive/eligibility.js"
import { isWithinCooldown } from "@shruti/proactive/cooldown.js"
import { validateAndScrubActions } from "@shruti/proactive/markerValidator.js"
import {
  arbitrate,
  collectDailyCandidates,
  reconcile,
  type NotificationCandidate,
} from "@shruti/proactive/notificationPlanner.js"
import { resolveRules } from "@shruti/proactive/registry.js"
// Side-effect import: each rule module calls `registerRule()` at load
// time so the registry knows about it. Removing this line silently
// disables every rule.
import "@shruti/proactive/rules/index.js"
import { resolveSessionId } from "@shruti/proactive/sessions.js"
import type { ProactiveContext, ResolvedProactiveRule } from "@shruti/proactive/types.js"
import { emit as emitProactive, on as onProactive } from "@shruti/proactive/events.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"

/** Foreground tick cadence — every 30 minutes while the app is open. */
const TICK_INTERVAL_MS = 30 * 60 * 1000
/** Trailing window for the listening-stats predicates. Matches what
 *  the activity heatmap uses elsewhere. */
const ACTIVITY_WINDOW_DAYS = 224
/** Garbage-collect terminal-state rows older than 90 days. */
const PROACTIVE_GC_RETENTION_DAYS = 90
/** How many days ahead the planner pre-arms the rolling daily reminder.
 *  Re-armed each tick, so the OS always holds ~2 weeks of daily pushes
 *  even if the app isn't opened for a while. */
const DAILY_HORIZON_DAYS = 14
/** The legacy recurring daily-reminder id (`useDailyReminder` used 9001).
 *  Cancelled once on the first planner run as a migration step. */
const LEGACY_DAILY_NOTIFICATION_ID = 9001

/**
 * Mobile-driven scheduler for agent-initiated chat messages. Mounted
 * once in `App.vue`; ticks on mount, every 30 minutes during foreground,
 * and on every `appStateChange` resume. On pause it gives rules a hook
 * to do speculative prep (currently only `inactivity`).
 *
 * Pipeline: registry resolution, eligibility gating, prep/notify/deliver,
 * and a per-row in-memory mutex guarding against overlapping ticks. The
 * rules themselves live in `proactive/rules` and are registered into the
 * registry (`proactive/registry.ts`) at import time.
 */
export function useProactiveScheduler(): void {
  const app = useShruti()
  const language = useAppLanguage()
  const purchases = usePurchasesStore()
  const { t } = useI18n()
  // First time the scheduler runs we stamp "install age" — the device
  // never sees a fresh install on the same DB twice, so a single config
  // key is enough. days_since_install_at_least reads this.
  const firstSeenAt = useConfig<number | null>("proactive.firstSeenAtMs", null)
  // Daily-reminder Settings toggles — the planner reads these to materialize
  // the rolling daily candidates (replacing the old recurring 9001 alarm).
  const dailyEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
  const dailyTime = useConfig<[number, number] | undefined>("settings.notificationsTime", [9, 0])

  /** Mutex keyed by `ruleKind|ruleDate`. Holds during prep/build so the
   *  next tick doesn't double-call an in-flight LLM/template build. */
  const inFlight = new Set<string>()

  /** Notification ids the planner currently owns → the signature each was
   *  last scheduled with. `runPlanner` runs on every tick (mount / 30-min
   *  interval / each foreground resume / each background) and `reconcile`
   *  uses this to skip re-arming an unchanged push and to cancel pushes
   *  that dropped out of the winning set. Module-scoped so it survives a
   *  remount of the composable within the same app session. */
  const plannerManaged = new Map<number, string>()

  /** Fast-retry counter for the "repos not open yet" path. App.vue mounts
   *  this composable before Welcome finishes opening the content DB, so the
   *  first few ticks bail; without this, the next legitimate tick wouldn't
   *  fire for 30 minutes. Capped at 60 (~5 minutes of polling). */
  let repoRetries = 0

  /** Single-flight guard for `tick()`. Without it, the onMounted call,
   *  the appStateChange resume callback and the setInterval can all
   *  fire within milliseconds of each other on cold-start (Capacitor
   *  emits an active state right after mount). Concurrent ticks both
   *  pass `findByRuleAndDate=null`, both call `resolveSessionId` (which
   *  for `new_session` always mints a fresh chat_sessions row), then
   *  only the first `repo.create` wins on the UNIQUE constraint — the
   *  second returns null and leaves an orphan empty session in the
   *  history list. The mutex prevents the race entirely. */
  let tickInFlight = false

  /** Guards the one-time legacy-9001 cancel so we don't re-cancel every
   *  planner run. */
  let legacyDailyCancelled = false

  let interval: ReturnType<typeof setInterval> | null = null
  let resumeHandle: PluginListenerHandle | null = null
  let pauseHandle: PluginListenerHandle | null = null
  let unsubscribeReplan: (() => void) | null = null

  function mutexKey(ruleKind: string, ruleDate: string): string {
    return `${ruleKind}|${ruleDate}`
  }

  function pad(n: number): string {
    return n < 10 ? `0${n}` : String(n)
  }

  function localDate(now: Date): string {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  }

  function localTime(now: Date): string {
    return `${pad(now.getHours())}:${pad(now.getMinutes())}`
  }

  async function gatherContext(): Promise<ProactiveContext> {
    const nowMs = Date.now()
    const now = new Date(nowMs)
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

    const permission = await app.notifications.checkPermission().catch(() => "unknown" as const)

    // Activity stats — best-effort. If repos are not ready yet (cold
    // boot, content DB still downloading) we fall back to zeros, which
    // makes most eligibility predicates fail and effectively suspends
    // the scheduler until the next tick.
    let totalListenedSeconds = 0
    let currentStreak = 0
    let completedTracks = 0
    try {
      const repos = app.repositories()
      const fromMs = nowMs - ACTIVITY_WINDOW_DAYS * 86_400_000
      const toMs = nowMs + 86_400_000
      const overview = await getActivityOverview(
        { fromMs, toMs, nowMs, totalDays: ACTIVITY_WINDOW_DAYS },
        {
          listeningSessions: repos.listeningSessions,
          playlistItems: repos.playlistItems,
          tracks: repos.tracks,
        }
      )
      totalListenedSeconds = overview.totalListenedSeconds
      currentStreak = overview.currentStreak
      completedTracks = overview.completedCount
    } catch (err) {
      // Repos not ready or query failed — leave zeros.
      if (typeof console !== "undefined") {
        console.debug("[proactive] activity overview unavailable:", err)
      }
    }

    if (firstSeenAt.value === null) {
      firstSeenAt.value = nowMs
    }

    return {
      nowMs,
      localDate: localDate(now),
      localTime: localTime(now),
      timezone,
      locale: language.value,
      hasNotificationsPermission: permission === "granted",
      isSubscribed: purchases.isSubscribed,
      totalListenedSeconds,
      currentStreak,
      completedTracks,
      firstSeenAtMs: firstSeenAt.value,
      t: (key: string, params?: Record<string, unknown>) => (params ? t(key, params) : t(key)),
      // Repos + proactiveChat live on ctx so rule handlers never call
      // `useShruti()` themselves — they stay framework-free and
      // testable. `app.repositories()` is safe to call here because
      // proactiveRepo() already gated us on both DBs being open at the
      // top of tick().
      repos: app.repositories(),
      proactiveChat: app.proactiveChat,
    }
  }

  function proactiveRepo(): IProactiveStateRepository | null {
    try {
      return app.repositories().proactiveState
    } catch {
      return null
    }
  }

  /**
   * Cool-down check: a rule won't fire again until `cooldown_hours`
   * have passed since the most recent non-pending instance. `dismissed`
   * counts the same as `ready` for cooldown — the user already saw it
   * (or actively closed it). `pending` rows don't gate a new instance,
   * they're still in flight.
   */
  async function isOnCooldown(
    rule: ResolvedProactiveRule,
    nowMs: number,
    repo: IProactiveStateRepository
  ): Promise<boolean> {
    // Short-circuit before the repo hit when cooldown is disabled.
    if (rule.config.cooldown_hours * 3_600_000 <= 0) return false
    const recent = await repo.listRecentByRule(rule.config.id, 1)
    return isWithinCooldown(rule.config, recent[0], nowMs)
  }

  async function reValidateRow(
    entry: ProactiveStateEntry,
    rule: ResolvedProactiveRule,
    ctx: ProactiveContext,
    repo: IProactiveStateRepository
  ): Promise<boolean> {
    try {
      const stillValid = await rule.handler.validate(entry, ctx)
      if (!stillValid) {
        await repo.updatePrepState(entry.chatMessageId, "superseded")
        // No notification to cancel here — the planner owns OS pushes. A
        // superseded row drops out of `listByPrepStates(["ready",
        // "degraded"])`, so `runPlanner` (run after this loop) won't
        // collect a candidate for it and `reconcile` cancels its id.
        return false
      }
      return true
    } catch (err) {
      console.warn("[proactive] validate threw", rule.config.id, err)
      // Keep the row — better to render a stale message than to wipe
      // one because validation flaked.
      return true
    }
  }

  async function prepIfStale(
    entry: ProactiveStateEntry,
    rule: ResolvedProactiveRule,
    ctx: ProactiveContext,
    repo: IProactiveStateRepository
  ): Promise<void> {
    const refreshMs = rule.config.refresh_if_older_than_hours * 3_600_000
    const isStale = entry.preparedAt === null || ctx.nowMs - entry.preparedAt > refreshMs
    if (!isStale && entry.prepState === "ready") return

    const key = mutexKey(entry.ruleKind, entry.ruleDate)
    if (inFlight.has(key)) return
    inFlight.add(key)
    try {
      const result = await rule.handler.buildContent(entry, ctx)
      if (result === null) return
      // `buildContent` returns actions typed as `ChatActionPayload | unknown`
      // because LLM-emitted markers (via the proactive port) come through
      // as `unknown`. The validator narrows + drops anything that doesn't
      // match the discriminated union, so the cast is safe here — bad
      // payloads end up scrubbed, not crashed-on.
      const scrubbed = await validateAndScrubActions(
        result.bodyMd,
        (result.actions ?? {}) as Record<string, ChatActionPayload>,
        app.repositories().tracks
      )
      await repo.updateContent(entry.chatMessageId, scrubbed.bodyMd, scrubbed.actions)
      await repo.updatePrepState(
        entry.chatMessageId,
        scrubbed.degraded ? "degraded" : "ready",
        ctx.nowMs
      )
      // Bump the session's updated_at to prep time so it sorts by when
      // the body actually became readable, not by the (earlier) detect
      // tick that minted the session. The session list orders by
      // updated_at DESC; without this a just-prepped proactive can sit
      // below older sessions. Best-effort — a failed touch only affects
      // ordering, not correctness.
      await app
        .repositories()
        .chatSessions.touch(entry.sessionId, ctx.nowMs)
        .catch(() => undefined)
      // The row just flipped to ready/degraded — listUnseenSessionIds
      // filters out `pending` rows, so without this emit the badge
      // would stay dark until something else (next 30-min tick, app
      // resume, user nav to chat) triggers a refresh.
      emitProactive("row-prepped")
    } catch (err) {
      console.warn("[proactive] buildContent threw", rule.config.id, err)
      await repo.updatePrepState(entry.chatMessageId, "degraded", ctx.nowMs).catch(() => undefined)
      emitProactive("row-prepped")
    } finally {
      inFlight.delete(key)
    }
  }

  /**
   * Single arbiter run. Gathers candidate pushes from every live
   * proactive row (via each rule's `collectNotifications`) plus the
   * daily reminder, keeps ONE per local day by priority, and reconciles
   * the OS scheduler to exactly that set.
   *
   * `phase` is `"foreground"` from a tick (user present → inactivity
   * pushes suppressed) and `"background"` from `onAppPause`.
   */
  async function runPlanner(
    ctx: ProactiveContext,
    rules: readonly ResolvedProactiveRule[],
    phase: "foreground" | "background"
  ): Promise<void> {
    const repo = proactiveRepo()
    if (!repo) return

    // One-time migration off the legacy recurring daily alarm (id 9001).
    // The planner now owns the daily reminder via per-date rolling ids;
    // cancel the old `every:"day"` alarm once so it doesn't double-fire.
    await migrateLegacyDailyAlarm()

    const byRule = new Map<string, ResolvedProactiveRule>()
    for (const r of rules) byRule.set(r.config.id, r)

    const live = await repo.listByPrepStates(["ready", "degraded"])
    const candidates: NotificationCandidate[] = []
    for (const entry of live) {
      const rule = byRule.get(entry.ruleKind)
      const collect = rule?.handler.collectNotifications
      if (!collect) continue
      let produced: NotificationCandidate[]
      try {
        produced = collect(entry, ctx, phase)
      } catch (err) {
        console.warn("[notify-planner] collect threw", entry.ruleKind, err)
        continue
      }
      for (const c of produced) {
        // Proactive (session-backed) candidates leave `title` empty so the
        // planner — which has async repo access — resolves the chat
        // session's title (holiday name, "Weekly progress", …), falling
        // back to the app name.
        const title =
          c.title !== ""
            ? c.title
            : (await app.repositories().chatSessions.getById(entry.sessionId))?.title?.trim() ||
              t("app.name")
        candidates.push(title === c.title ? c : { ...c, title })
      }
    }

    // Daily reminder — a rolling window of per-date candidates.
    const time = dailyTime.value ? `${pad(dailyTime.value[0])}:${pad(dailyTime.value[1])}` : "09:00"
    candidates.push(
      ...collectDailyCandidates({
        enabled: dailyEnabled.value,
        time,
        title: t("app.name"),
        body: t("notifications.timeToListen"),
        nowMs: ctx.nowMs,
        horizonDays: DAILY_HORIZON_DAYS,
      })
    )

    const winners = arbitrate(candidates, ctx.nowMs)
    await reconcile(winners, app.notifications, plannerManaged)

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

  /** Cancel the legacy `every:"day"` reminder (id 9001) exactly once per
   *  app session. The planner replaces it with rolling per-date ids; if
   *  both lived, the user would get a duplicate daily push. */
  async function migrateLegacyDailyAlarm(): Promise<void> {
    if (legacyDailyCancelled) return
    legacyDailyCancelled = true
    try {
      await app.notifications.cancel(LEGACY_DAILY_NOTIFICATION_ID)
    } catch (err) {
      console.warn("[notify-planner] legacy daily cancel failed", err)
    }
  }

  async function readRemoteProactiveConfig(): Promise<ProactiveConfig | null> {
    try {
      const configUrl = app.storagePublicUrl.get(app.appConfig.publicRemoteConfigPath)
      const raw = await app.filesStorage.getJson<RemoteAppConfig>(configUrl)
      return raw.proactive ?? null
    } catch {
      // No remote config cached / network unavailable — fall back to
      // bundled defaults. Master kill switch can still flip "off" via
      // the next successful fetch.
      return null
    }
  }

  async function tick(): Promise<void> {
    if (tickInFlight) return
    tickInFlight = true
    try {
      await tickInner()
    } finally {
      tickInFlight = false
    }
  }

  async function tickInner(): Promise<void> {
    const repo = proactiveRepo()
    if (!repo) {
      // App.vue mounts this composable BEFORE Welcome finishes opening
      // the content/user DB, so the first few ticks hit a "DB not open"
      // throw from app.repositories(). Without this retry, the next
      // legitimate tick wouldn't fire for 30 minutes (or until an
      // appStateChange resume — never fires while a browser tab stays
      // in focus). Cap iterations so a real outage doesn't spin forever.
      if (repoRetries < 60) {
        repoRetries++
        setTimeout(() => void tick(), 5000)
      }
      return
    }
    repoRetries = 0
    // Tell subscribers (chat store via useChatStoreProactiveSync) that
    // a tick is happening so they can refresh derived state. Decoupled
    // via the event bus — the scheduler doesn't import any UI store.
    emitProactive("tick-ready")
    // Master kill switch — `config.proactive.master_enabled === false`
    // in the published config.json hard-disables the subsystem so we
    // can pull it from production without an app release.
    const remoteConfig = await readRemoteProactiveConfig()
    if (remoteConfig?.master_enabled === false) return
    const ctx = await gatherContext()
    const rules = resolveRules(remoteConfig?.rules ?? [])
    if (rules.length === 0) return

    // 1. Detect new instances.
    const sessions = app.repositories().chatSessions
    for (const rule of rules) {
      if (!isEligible(rule.config.eligibility, ctx)) continue
      if (await isOnCooldown(rule, ctx.nowMs, repo)) continue

      let detected: readonly Awaited<ReturnType<typeof rule.handler.detect>>[number][]
      try {
        detected = [...(await rule.handler.detect(ctx, rule.config))]
      } catch (err) {
        console.warn("[proactive] detect threw", rule.config.id, err)
        continue
      }
      for (const det of detected) {
        // UNIQUE(rule_kind, rule_date) idempotency check before we
        // create a fresh chat_session — otherwise re-detection on a
        // 30-minute tick would litter the history with empty sessions.
        const existing = await repo.findByRuleAndDate(rule.config.id, det.ruleDate)
        if (existing !== null) continue
        try {
          // Belt-and-braces: even with `tickInFlight` guarding re-entry,
          // a previous APK install / hot-reload could leave a row that
          // our findByRuleAndDate above missed because of a transient
          // DB issue. Capture the sessionId before we mint the chat
          // session so we can roll it back if repo.create dedups.
          const sessionId = await resolveSessionId(rule, det, ctx.nowMs, sessions)
          const chatMessageId = randomChatMessageId()
          const created = await repo.create({
            chatMessageId,
            sessionId,
            role: "assistant",
            content: "",
            createdAt: ctx.nowMs,
            visibleAt: det.visibleAt,
            notify: det.notify,
            ruleKind: rule.config.id,
            ruleDate: det.ruleDate,
            prepState: "pending",
          })
          if (created === null) {
            // The proactive_state row for (ruleKind, ruleDate) already
            // exists — the chat_session we just minted is an orphan.
            // Delete it so the history list stays clean.
            await sessions.delete(sessionId).catch(() => undefined)
            continue
          }
          // Tell subscribers a row was just persisted. The chat store
          // listens via useChatStoreProactiveSync and refreshes its
          // sessions list so the new entry appears without a tab
          // switch. Scheduler stays oblivious to who reacts.
          emitProactive("row-created")
        } catch (err) {
          console.warn("[proactive] create threw", rule.config.id, err)
        }
      }
    }

    // 2. Re-validate and prep existing rows.
    const live = await repo.listByPrepStates(["pending", "ready", "degraded"])
    const byRule = new Map<string, ResolvedProactiveRule>()
    for (const r of rules) byRule.set(r.config.id, r)

    for (const entry of live) {
      const rule = byRule.get(entry.ruleKind)
      if (!rule) continue
      const stillValid = await reValidateRow(entry, rule, ctx, repo)
      if (!stillValid) continue
      await prepIfStale(entry, rule, ctx, repo)
    }

    // 3. Arbitrate all engagement pushes into ONE per local day and
    // reconcile the OS scheduler. Runs after prep so freshly-built rows
    // carry their content into the candidate's body.
    await runPlanner(ctx, rules, "foreground")
  }

  async function onPause(): Promise<void> {
    const repo = proactiveRepo()
    if (!repo) return
    const remoteConfig = await readRemoteProactiveConfig()
    if (remoteConfig?.master_enabled === false) return
    const ctx = await gatherContext()
    const rules = resolveRules(remoteConfig?.rules ?? [])
    for (const rule of rules) {
      if (!rule.handler.onAppPause) continue
      if (!isEligible(rule.config.eligibility, ctx)) continue
      try {
        await rule.handler.onAppPause(ctx)
      } catch (err) {
        console.warn("[proactive] onAppPause threw", rule.config.id, err)
      }
    }
    // Speculative-prep rules (inactivity, unfinished_lecture) just
    // (re)anchored their rows. Run the planner in the background phase so
    // their away-only pushes get armed for the OS while the app is closed.
    await runPlanner(ctx, rules, "background")
  }

  async function sweepOldRows(): Promise<void> {
    const repo = proactiveRepo()
    if (!repo) return
    const cutoffSec = Math.floor(Date.now() / 1000) - PROACTIVE_GC_RETENTION_DAYS * 86_400
    try {
      const n = await repo.sweepTerminal(cutoffSec)
      if (n > 0 && typeof console !== "undefined") {
        console.debug(`[proactive] swept ${n} dismissed/superseded rows`)
      }
    } catch (err) {
      console.warn("[proactive] sweep failed:", err)
    }
  }

  onMounted(() => {
    void tick()
    // GC once per cold start — running it on every tick would be
    // wasteful and dismissed rows aren't time-sensitive.
    void sweepOldRows()
    interval = setInterval(() => void tick(), TICK_INTERVAL_MS)
    void CapApp.addListener("appStateChange", (state) => {
      if (state.isActive) {
        void tick()
      } else {
        void onPause()
      }
    }).then((handle) => {
      resumeHandle = handle
    })
    // Settings flipping the daily-reminder toggle emits `replan` — re-run
    // a foreground tick so the daily push is (un)armed promptly instead of
    // waiting up to 30 minutes for the next interval.
    unsubscribeReplan = onProactive("replan", () => void tick())
  })

  onBeforeUnmount(() => {
    if (interval !== null) {
      clearInterval(interval)
      interval = null
    }
    void resumeHandle?.remove()
    resumeHandle = null
    void pauseHandle?.remove()
    pauseHandle = null
    unsubscribeReplan?.()
    unsubscribeReplan = null
  })
}

function randomChatMessageId(): ChatMessageId {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID() as ChatMessageId
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}` as ChatMessageId
}

/**
 * Stable 32-bit hash of a string id for use as Capacitor notification
 * id. djb2 — same on every platform/version, so cancel(id) and
 * schedule(id) line up across app restarts.
 */
