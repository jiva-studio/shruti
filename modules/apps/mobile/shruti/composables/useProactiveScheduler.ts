import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import type { ProactiveConfig, RemoteAppConfig } from "@lib/domain/config.js"
import type { AppLifecycleSubscription } from "@ports/app/index.js"
import { createProactiveEngine } from "@usecases/proactive/proactiveEngine.js"
import { createProactivePlannerRun } from "@usecases/proactive/planNotifications.js"
import { createProactivePrep } from "@usecases/proactive/prepProactiveRow.js"
import { PROACTIVE_RULES } from "@usecases/proactive/rules/index.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useProactiveContext } from "@shruti/composables/useProactiveContext.js"
import { reportNotifyPlannerFailure } from "@shruti/services/notifyPlannerFailures.js"
import { emit as emitProactive, on as onProactive } from "@shruti/services/proactiveEvents.js"
import { useShruti } from "@shruti/shruti.js"

/** Foreground tick cadence — every 30 minutes while the app is open. */
const TICK_INTERVAL_MS = 30 * 60 * 1000

/**
 * Mobile-driven scheduler for agent-initiated chat messages. Mounted
 * once in `App.vue`; ticks on mount, every 30 minutes during foreground,
 * and on every resume. On pause it gives rules a hook to do speculative
 * prep. The pipeline itself is `createProactiveEngine`; this composable
 * owns when it runs.
 */
export function useProactiveScheduler(): void {
  const app = useShruti()
  const { t } = useI18n()
  // Daily-reminder Settings toggles — the planner reads these to materialize
  // the rolling daily candidates.
  const dailyEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
  const dailyTime = useConfig<[number, number] | undefined>("settings.notificationsTime", [9, 0])

  // Throws while the databases are not open yet, or once sign-out closed them.
  const openRepositories = () => {
    try {
      return app.repositories()
    } catch {
      return null
    }
  }

  const engine = createProactiveEngine({
    // Not open yet: the tick reports not-ready and retries.
    proactiveState: () => openRepositories()?.proactiveState ?? null,
    readConfig: readRemoteProactiveConfig,
    gatherContext: useProactiveContext(),
    rules: PROACTIVE_RULES,
    prep: createProactivePrep({ emit: emitProactive }),
    runPlanner: createProactivePlannerRun({
      notifications: app.notifications,
      reportFailure: reportNotifyPlannerFailure,
      t,
      repositories: openRepositories,
      dailyReminder: () => ({ enabled: dailyEnabled.value, time: dailyTime.value }),
    }),
    emit: emitProactive,
  })

  /** Fast-retry counter for the "repos not open yet" path. App.vue mounts
   *  this composable before Welcome finishes opening the content DB, so the
   *  first few ticks bail; without this, the next legitimate tick wouldn't
   *  fire for 30 minutes. Capped at 60 (~5 minutes of polling). */
  let repoRetries = 0

  /** Single-flight guard for `tick()`. Without it, the onMounted call,
   *  the resume callback and the setInterval can all fire within
   *  milliseconds of each other on cold-start (Capacitor emits an active
   *  state right after mount). Concurrent ticks both pass
   *  `findByRuleAndDate=null`, both call `resolveSessionId` (which for
   *  `new_session` always mints a fresh chat_sessions row), then only the
   *  first `repo.create` wins on the UNIQUE constraint — the second returns
   *  null and leaves an orphan empty session in the history list. The mutex
   *  prevents the race entirely. */
  let tickInFlight = false

  let interval: ReturnType<typeof setInterval> | null = null
  let resumeHandle: AppLifecycleSubscription | null = null
  let unsubscribeReplan: (() => void) | null = null

  async function readRemoteProactiveConfig(): Promise<ProactiveConfig | null> {
    try {
      const configUrl = app.storagePublicUrl.get(app.appConfig.publicRemoteConfigPath)
      const raw = await app.remoteJson.getJson<RemoteAppConfig>(configUrl)
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
      // Only a pass that found the databases open gets past the first step,
      // so any other outcome — a throw included — ends the retry run.
      const outcome = await engine.tick().catch((err: unknown) => {
        repoRetries = 0
        throw err
      })
      if (outcome === "not-ready") {
        // Without this retry the next legitimate tick wouldn't fire for 30
        // minutes (or until a resume — never, while a browser tab stays in
        // focus). Capped so a real outage doesn't spin forever.
        if (repoRetries < 60) {
          repoRetries++
          setTimeout(() => void tick(), 5000)
        }
      } else {
        repoRetries = 0
      }
    } finally {
      tickInFlight = false
      // End-of-tick marker. Subscribers that coalesce per-tick activity
      // (the chat toast groups all rows prepped this tick into ONE
      // notification) flush here. Emitted in `finally` so it fires even
      // when the tick early-returns (no repo / master off / no rules)
      // or throws — the coalescer must never be left waiting.
      emitProactive("tick-settled")
    }
  }

  onMounted(() => {
    void tick()
    // GC once per cold start — running it on every tick would be
    // wasteful and dismissed rows aren't time-sensitive.
    void engine.sweep(app.clock.now())
    interval = setInterval(() => void tick(), TICK_INTERVAL_MS)
    void app.appLifecycle
      .onStateChange((state) => {
        if (state.isActive) {
          void tick()
        } else {
          void engine.pause()
        }
      })
      .then((handle) => {
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
    unsubscribeReplan?.()
    unsubscribeReplan = null
  })
}
