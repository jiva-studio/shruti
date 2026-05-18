import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import type { ProactiveConfig, RemoteAppConfig } from "@lib/domain/config.js"
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
import { notificationIdFor } from "@shruti/proactive/hash.js"
import { validateAndScrubActions } from "@shruti/proactive/markerValidator.js"
import { resolveRules } from "@shruti/proactive/registry.js"
import { recordEvent } from "@shruti/proactive/telemetry.js"
// Side-effect import: each rule module calls `registerRule()` at load
// time so the registry knows about it. Removing this line silently
// disables every rule.
import "@shruti/proactive/rules/index.js"
import { resolveSessionId } from "@shruti/proactive/sessions.js"
import type { ProactiveContext, ResolvedProactiveRule } from "@shruti/proactive/types.js"
import { useChatStore } from "@shruti/stores/useChatStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"

/** Foreground tick cadence — every 30 minutes while the app is open. */
const TICK_INTERVAL_MS = 30 * 60 * 1000
/** Trailing window for the listening-stats predicates. Matches what
 *  the activity heatmap uses elsewhere. */
const ACTIVITY_WINDOW_DAYS = 224
/** Garbage-collect terminal-state rows older than 90 days. */
const PROACTIVE_GC_RETENTION_DAYS = 90

/**
 * Mobile-driven scheduler for agent-initiated chat messages. Mounted
 * once in `App.vue`; ticks on mount, every 30 minutes during foreground,
 * and on every `appStateChange` resume. On pause it gives rules a hook
 * to do speculative prep (currently only `inactivity`).
 *
 * Phase 2 ships the skeleton: registry resolution, eligibility gating,
 * the prep/notify/deliver pipeline, and a per-row in-memory mutex
 * guarding against overlapping ticks. The registry is empty in this
 * phase — rule handlers register themselves from their own modules
 * starting in Phase 4.
 */
export function useProactiveScheduler(): void {
  const app = useShruti()
  const language = useAppLanguage()
  const purchases = usePurchasesStore()
  const chatStore = useChatStore()
  const { t } = useI18n()
  // First time the scheduler runs we stamp "install age" — the device
  // never sees a fresh install on the same DB twice, so a single config
  // key is enough. days_since_install_at_least reads this.
  const firstSeenAt = useConfig<number | null>("proactive.firstSeenAtMs", null)

  /** Mutex keyed by `ruleKind|ruleDate`. Holds during prep/build so the
   *  next tick doesn't double-call an in-flight LLM/template build. */
  const inFlight = new Set<string>()

  /** Fast-retry counter for the "repos not open yet" path. App.vue mounts
   *  this composable before Welcome finishes opening the content DB, so the
   *  first few ticks bail; without this, the next legitimate tick wouldn't
   *  fire for 30 minutes. Capped at 60 (~5 minutes of polling). */
  let repoRetries = 0

  let interval: ReturnType<typeof setInterval> | null = null
  let resumeHandle: PluginListenerHandle | null = null
  let pauseHandle: PluginListenerHandle | null = null

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
    const cooldownMs = rule.config.cooldown_hours * 3_600_000
    if (cooldownMs <= 0) return false
    const recent = await repo.listRecentByRule(rule.config.id, 1)
    if (recent.length === 0) return false
    const last = recent[0]
    if (last.prepState === "pending" || last.prepState === "superseded") return false
    // `dismiss_resets_after_hours` overrides the default cooldown for
    // rows the user explicitly dismissed — a soft upsell can come back
    // sooner than the "user already saw and accepted" path.
    const effectiveCooldownMs =
      last.prepState === "dismissed" && rule.config.dismiss_resets_after_hours !== undefined
        ? rule.config.dismiss_resets_after_hours * 3_600_000
        : cooldownMs
    return nowMs - last.createdAt < effectiveCooldownMs
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
        // If a LocalNotification was already scheduled for this entry
        // (inactivity rule is the canonical case), cancel it — without
        // this the OS will still fire the alarm and the deep-link will
        // land on a hidden chat message.
        if (entry.notifiedAt !== null) {
          try {
            await app.notifications.cancel(notificationIdFor(entry.chatMessageId))
          } catch (err) {
            console.warn("[proactive] cancel notification failed", entry.chatMessageId, err)
          }
        }
        void recordEvent(app.preferences, rule.config.id, "superseded")
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
      const scrubbed = await validateAndScrubActions(
        result.bodyMd,
        result.actions ?? {},
        app.repositories().tracks
      )
      await repo.updateContent(entry.chatMessageId, scrubbed.bodyMd, scrubbed.actions)
      await repo.updatePrepState(
        entry.chatMessageId,
        scrubbed.degraded ? "degraded" : "ready",
        ctx.nowMs
      )
      void recordEvent(app.preferences, rule.config.id, scrubbed.degraded ? "degraded" : "ready")
    } catch (err) {
      console.warn("[proactive] buildContent threw", rule.config.id, err)
      await repo.updatePrepState(entry.chatMessageId, "degraded", ctx.nowMs).catch(() => undefined)
    } finally {
      inFlight.delete(key)
    }
  }

  async function scheduleNotificationIfNeeded(entry: ProactiveStateEntry): Promise<void> {
    if (entry.notifyAt === null) return
    if (entry.notifiedAt !== null) return

    // Past `notify_at` used to silently skip the schedule. That's fine
    // for events whose visible_on already rolled off (we don't want a
    // late notification two weeks after a holiday), but for today's
    // event whose notify hour already passed we want to surface it now
    // — otherwise the user only ever sees notifications for holidays
    // detected ≥48h in advance. Fire ~5s out so the OS has time to
    // accept the schedule and the user lands on the chat without the
    // notification racing the row's prep_state transition.
    const notifyAtMs = entry.notifyAt * 1000
    let fireAtMs = notifyAtMs
    if (fireAtMs <= Date.now()) {
      if (entry.visibleOn !== todayLocalDate()) {
        // Event isn't for today — let it stay silently expired.
        return
      }
      fireAtMs = Date.now() + 5_000
    }

    // Capacitor LocalNotifications.id is a 32-bit integer; chat_message
    // ids are random text. We hash to keep cancel-safety while staying
    // in-bounds.
    const id = notificationIdFor(entry.chatMessageId)
    try {
      await app.notifications.schedule({
        id,
        title: "",
        body: "",
        at: fireAtMs,
        extra: {
          chatSessionId: entry.sessionId,
          chatMessageId: entry.chatMessageId,
        },
      })
      const repo = proactiveRepo()
      if (repo) await repo.markNotified(entry.chatMessageId, Math.floor(Date.now() / 1000))
      void recordEvent(app.preferences, entry.ruleKind, "notified")
    } catch (err) {
      console.warn("[proactive] schedule notification failed", entry.chatMessageId, err)
    }
  }

  function todayLocalDate(): string {
    const now = new Date()
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
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
        detected = [...(await rule.handler.detect(ctx))]
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
          const sessionId = await resolveSessionId(rule, det, ctx.nowMs, sessions)
          const chatMessageId = randomChatMessageId()
          await repo.create({
            chatMessageId,
            sessionId,
            role: "assistant",
            content: "",
            createdAt: ctx.nowMs,
            visibleOn: det.visibleOn,
            notifyAt: det.notifyAt,
            ruleKind: rule.config.id,
            ruleDate: det.ruleDate,
            prepState: "pending",
          })
          void recordEvent(app.preferences, rule.config.id, "detected")
          // Scheduler writes the chat_sessions/chat_messages rows directly
          // through repos, so the Pinia chat store's in-memory `sessions`
          // list doesn't know about the new entry until something forces a
          // refresh. Without this, the new proactive session only appears
          // when the user navigates away and back. Best-effort — if the
          // store throws (e.g. user repo not ready in some edge case) we
          // swallow to keep the scheduler resilient.
          void chatStore.refreshSessions().catch(() => undefined)
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
      await scheduleNotificationIfNeeded(entry)
    }
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
