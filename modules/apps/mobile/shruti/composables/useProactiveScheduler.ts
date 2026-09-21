import { onBeforeUnmount, onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { App as CapApp } from "@capacitor/app"
import type { PluginListenerHandle } from "@capacitor/core"
import type { ProactiveConfig, RemoteAppConfig } from "@lib/domain/config.js"
import type { IProactiveStateRepository } from "@lib/domain/ports/proactiveStateRepository.js"
import { useConfig } from "@shruti/composables/useConfig.js"
import { useShruti } from "@shruti/shruti.js"
import { createProactivePlannerRun } from "@shruti/composables/proactivePlannerRun.js"
import { createProactivePrep } from "@shruti/composables/proactivePrep.js"
import { useProactiveContext } from "@shruti/composables/useProactiveContext.js"
import { detectForRule } from "@shruti/composables/proactiveDetect.js"
import { isEligible } from "@shruti/proactive/eligibility.js"
import { resolveRules } from "@shruti/proactive/registry.js"
// Side-effect import: each rule module calls `registerRule()` at load
// time so the registry knows about it. Removing this line silently
// disables every rule.
import "@shruti/proactive/rules/index.js"
import type { ProactiveContext, ResolvedProactiveRule } from "@shruti/proactive/types.js"
import { emit as emitProactive, on as onProactive } from "@shruti/proactive/events.js"

/** Foreground tick cadence — every 30 minutes while the app is open. */
const TICK_INTERVAL_MS = 30 * 60 * 1000
/** Garbage-collect terminal-state rows older than 90 days. */
const PROACTIVE_GC_RETENTION_DAYS = 90

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
  const { t } = useI18n()
  // Daily-reminder Settings toggles — the planner reads these to materialize
  // the rolling daily candidates (replacing the old recurring 9001 alarm).
  const dailyEnabled = useConfig<boolean>("settings.notificationsEnabled", false)
  const dailyTime = useConfig<[number, number] | undefined>("settings.notificationsTime", [9, 0])

  const gatherContext = useProactiveContext()
  const { isOnCooldown, reValidateRow, prepIfStale } = createProactivePrep({ app })
  const runPlanner = createProactivePlannerRun({ app, t, dailyEnabled, dailyTime })

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

  let interval: ReturnType<typeof setInterval> | null = null
  let resumeHandle: PluginListenerHandle | null = null
  let pauseHandle: PluginListenerHandle | null = null
  let unsubscribeReplan: (() => void) | null = null

  function proactiveRepo(): IProactiveStateRepository | null {
    try {
      return app.repositories().proactiveState
    } catch {
      return null
    }
  }

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
      await tickInner()
    } finally {
      tickInFlight = false
      // End-of-tick marker. Subscribers that coalesce per-tick activity
      // (the chat toast groups all rows prepped this tick into ONE
      // notification) flush here. Emitted in `finally` so it fires even
      // when `tickInner` early-returns (no repo / master off / no rules)
      // or throws — the coalescer must never be left waiting.
      emitProactive("tick-settled")
    }
  }

  /** 1. Detect new instances. */
  async function detectAll(
    rules: readonly ResolvedProactiveRule[],
    ctx: ProactiveContext,
    repo: IProactiveStateRepository
  ): Promise<void> {
    const sessions = app.repositories().chatSessions
    for (const rule of rules) {
      if (!isEligible(rule.config.eligibility, ctx)) continue
      if (await isOnCooldown(rule, ctx.nowMs, repo)) continue
      await detectForRule(rule, ctx, repo, sessions)
    }
  }

  /** 2. Re-validate and prep existing rows. */
  async function prepLiveRows(
    rules: readonly ResolvedProactiveRule[],
    ctx: ProactiveContext,
    repo: IProactiveStateRepository
  ): Promise<void> {
    const byRule = new Map<string, ResolvedProactiveRule>()
    for (const rule of rules) byRule.set(rule.config.id, rule)
    for (const entry of await repo.listByPrepStates(["pending", "ready", "degraded"])) {
      const rule = byRule.get(entry.ruleKind)
      if (!rule) continue
      if (!(await reValidateRow(entry, rule, ctx, repo))) continue
      await prepIfStale(entry, rule, ctx, repo)
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

    await detectAll(rules, ctx, repo)
    await prepLiveRows(rules, ctx, repo)

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
