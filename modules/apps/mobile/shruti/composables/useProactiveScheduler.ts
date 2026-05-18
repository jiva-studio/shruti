import { onBeforeUnmount, onMounted } from "vue"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import type {
  IProactiveStateRepository,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"
import { getActivityOverview } from "@lib/application/getActivityOverview.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useShruti } from "@shruti/shruti.js"
import { isEligible } from "@shruti/proactive/eligibility.js"
import { resolveRules } from "@shruti/proactive/registry.js"
import type {
  ProactiveContext,
  ResolvedProactiveRule,
} from "@shruti/proactive/types.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"

/** Foreground tick cadence — every 30 minutes while the app is open. */
const TICK_INTERVAL_MS = 30 * 60 * 1000
/** Trailing window for the listening-stats predicates. Matches what
 *  the activity heatmap uses elsewhere. */
const ACTIVITY_WINDOW_DAYS = 224

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
  // First time the scheduler runs we stamp "install age" — the device
  // never sees a fresh install on the same DB twice, so a single config
  // key is enough. days_since_install_at_least reads this.
  const firstSeenAt = useConfig<number | null>("proactive.firstSeenAtMs", null)

  /** Mutex keyed by `ruleKind|ruleDate`. Holds during prep/build so the
   *  next tick doesn't double-call an in-flight LLM/template build. */
  const inFlight = new Set<string>()

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

    const permission = await app.notifications
      .checkPermission()
      .catch(() => "unknown" as const)

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
    return nowMs - last.createdAt < cooldownMs
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
    const isStale =
      entry.preparedAt === null || ctx.nowMs - entry.preparedAt > refreshMs
    if (!isStale && entry.prepState === "ready") return

    const key = mutexKey(entry.ruleKind, entry.ruleDate)
    if (inFlight.has(key)) return
    inFlight.add(key)
    try {
      const result = await rule.handler.buildContent(entry, ctx)
      if (result === null) return
      await repo.updateContent(entry.chatMessageId, result.bodyMd)
      await repo.updatePrepState(entry.chatMessageId, "ready", ctx.nowMs)
    } catch (err) {
      console.warn("[proactive] buildContent threw", rule.config.id, err)
      await repo
        .updatePrepState(entry.chatMessageId, "degraded", ctx.nowMs)
        .catch(() => undefined)
    } finally {
      inFlight.delete(key)
    }
  }

  async function scheduleNotificationIfNeeded(entry: ProactiveStateEntry): Promise<void> {
    if (entry.notifyAt === null) return
    if (entry.notifiedAt !== null) return
    if (entry.notifyAt * 1000 <= Date.now()) return

    // Capacitor LocalNotifications.id is a 32-bit integer; chat_message
    // ids are random text. We hash to keep cancel-safety while staying
    // in-bounds.
    const id = hashStringToInt32(entry.chatMessageId)
    try {
      await app.notifications.schedule({
        id,
        title: "",
        body: "",
        at: entry.notifyAt * 1000,
        extra: {
          chatSessionId: entry.sessionId,
          chatMessageId: entry.chatMessageId,
        },
      })
      const repo = proactiveRepo()
      if (repo) await repo.markNotified(entry.chatMessageId, Math.floor(Date.now() / 1000))
    } catch (err) {
      console.warn("[proactive] schedule notification failed", entry.chatMessageId, err)
    }
  }

  async function tick(): Promise<void> {
    const repo = proactiveRepo()
    if (!repo) return
    const ctx = await gatherContext()
    const rules = resolveRules(/* remote overrides arrive via config.json — Phase 7+ */ [])
    if (rules.length === 0) return

    // 1. Detect new instances.
    for (const rule of rules) {
      if (!isEligible(rule.config.eligibility, ctx)) continue
      if (await isOnCooldown(rule, ctx.nowMs, repo)) continue

      let detected: readonly { ruleDate: string }[] = []
      try {
        detected = await rule.handler.detect(ctx)
      } catch (err) {
        console.warn("[proactive] detect threw", rule.config.id, err)
        continue
      }
      // Phase 2 ships no handlers, so this is a no-op for now. INSERT
      // wiring lives in the handler's content builder + the create()
      // call it makes against the repo — Phase 4 fleshes this out.
      void detected
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
    const ctx = await gatherContext()
    const rules = resolveRules([])
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

  onMounted(() => {
    void tick()
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

/**
 * Stable 32-bit hash of a string id for use as Capacitor notification
 * id. djb2 — same on every platform/version, so cancel(id) and
 * schedule(id) line up across app restarts.
 */
function hashStringToInt32(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  // Map into the positive int32 range — Capacitor requires positive.
  return Math.abs(h) || 1
}
