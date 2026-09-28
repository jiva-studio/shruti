import type { ProactiveConfig } from "@lib/domain/config.js"
import type { IProactiveStateRepository } from "@lib/domain/ports/proactiveStateRepository.js"
import { detectForRule } from "./detectForRule.js"
import { isEligible } from "./eligibility.js"
import type { RunPlanner } from "./planNotifications.js"
import type { ProactivePrep } from "./prepProactiveRow.js"
import { resolveRules } from "./registry.js"
import type {
  ProactiveContext,
  ProactiveEvent,
  ProactiveRuleHandler,
  ResolvedProactiveRule,
} from "./types.js"

/** Garbage-collect terminal-state rows older than 90 days. */
const PROACTIVE_GC_RETENTION_DAYS = 90

export interface ProactiveEngineDeps {
  /** The proactive-state repository, or `null` while the databases are not open yet. */
  readonly proactiveState: () => IProactiveStateRepository | null
  /** The `proactive` block of the published config, or `null` when it cannot be read. */
  readonly readConfig: () => Promise<ProactiveConfig | null>
  readonly gatherContext: () => Promise<ProactiveContext>
  readonly rules: readonly ProactiveRuleHandler[]
  readonly prep: ProactivePrep
  readonly runPlanner: RunPlanner
  readonly emit: (event: ProactiveEvent) => void
}

export interface ProactiveEngine {
  /** One foreground pass: detect, re-validate and prep, then plan the pushes.
   *  `"not-ready"` when the databases are not open yet and nothing ran. */
  tick(): Promise<"ran" | "not-ready">
  /** The app is going to the background: rules arm their away-only rows and
   *  the planner schedules the pushes for while the app is closed. */
  pause(): Promise<void>
  /** Drop dismissed and superseded rows past the retention window. */
  sweep(nowMs: number): Promise<void>
}

/**
 * The agent-initiated chat pipeline: registry resolution, eligibility gating,
 * detection, prep, and the notification planner. The caller owns when it runs
 * and makes sure two passes never overlap.
 */
export function createProactiveEngine(deps: ProactiveEngineDeps): ProactiveEngine {
  /** The published config, and whether its master kill switch is off — which
   *  pulls the subsystem from production without an app release. */
  async function readSwitchedConfig(): Promise<{ config: ProactiveConfig | null; off: boolean }> {
    const config = await deps.readConfig()
    return { config, off: config?.master_enabled === false }
  }

  async function detectAll(
    rules: readonly ResolvedProactiveRule[],
    ctx: ProactiveContext,
    repo: IProactiveStateRepository
  ): Promise<void> {
    for (const rule of rules) {
      if (!isEligible(rule.config.eligibility, ctx)) continue
      if (await deps.prep.isOnCooldown(rule, ctx.nowMs, repo)) continue
      await detectForRule(rule, ctx, repo, ctx.repos.chatSessions, deps.emit)
    }
  }

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
      if (!(await deps.prep.reValidateRow(entry, rule, ctx, repo))) continue
      await deps.prep.prepIfStale(entry, rule, ctx, repo)
    }
  }

  async function tick(): Promise<"ran" | "not-ready"> {
    const repo = deps.proactiveState()
    if (!repo) return "not-ready"
    // Subscribers refresh derived state on this; every database is open.
    deps.emit("tick-ready")
    const { config, off } = await readSwitchedConfig()
    if (off) return "ran"
    const ctx = await deps.gatherContext()
    const rules = resolveRules(deps.rules, config?.rules ?? [])
    if (rules.length === 0) return "ran"

    await detectAll(rules, ctx, repo)
    await prepLiveRows(rules, ctx, repo)
    // Runs after prep so freshly-built rows carry their content into the
    // candidate's body.
    await deps.runPlanner(ctx, rules, "foreground")
    return "ran"
  }

  async function pause(): Promise<void> {
    if (!deps.proactiveState()) return
    const { config, off } = await readSwitchedConfig()
    if (off) return
    const ctx = await deps.gatherContext()
    const rules = resolveRules(deps.rules, config?.rules ?? [])
    for (const rule of rules) {
      if (!rule.handler.onAppPause) continue
      if (!isEligible(rule.config.eligibility, ctx)) continue
      try {
        await rule.handler.onAppPause(ctx)
      } catch (err) {
        console.warn("[proactive] onAppPause threw", rule.config.id, err)
      }
    }
    // The speculative-prep rules just (re)anchored their rows; the background
    // phase arms their away-only pushes.
    await deps.runPlanner(ctx, rules, "background")
  }

  async function sweep(nowMs: number): Promise<void> {
    const repo = deps.proactiveState()
    if (!repo) return
    const cutoffSec = Math.floor(nowMs / 1000) - PROACTIVE_GC_RETENTION_DAYS * 86_400
    try {
      const n = await repo.sweepTerminal(cutoffSec)
      if (n > 0 && typeof console !== "undefined") {
        console.debug(`[proactive] swept ${n} dismissed/superseded rows`)
      }
    } catch (err) {
      console.warn("[proactive] sweep failed:", err)
    }
  }

  return { tick, pause, sweep }
}
