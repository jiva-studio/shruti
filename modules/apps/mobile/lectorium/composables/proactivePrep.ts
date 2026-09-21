import type { useLectorium } from "@lectorium/lectorium.js"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type {
  IProactiveStateRepository,
  ProactiveStateEntry,
} from "@lib/domain/ports/proactiveStateRepository.js"
import { isWithinCooldown } from "@lectorium/proactive/cooldown.js"
import { isPrepStale } from "@lectorium/proactive/staleness.js"
import { validateAndScrubActions } from "@lectorium/proactive/markerValidator.js"
import { emit } from "@lectorium/proactive/events.js"
import type { ProactiveContext, ResolvedProactiveRule } from "@lectorium/proactive/types.js"

type Lectorium = ReturnType<typeof useLectorium>

export interface ProactivePrep {
  isOnCooldown: (
    rule: ResolvedProactiveRule,
    nowMs: number,
    repo: IProactiveStateRepository
  ) => Promise<boolean>
  reValidateRow: (
    entry: ProactiveStateEntry,
    rule: ResolvedProactiveRule,
    ctx: ProactiveContext,
    repo: IProactiveStateRepository
  ) => Promise<boolean>
  prepIfStale: (
    entry: ProactiveStateEntry,
    rule: ResolvedProactiveRule,
    ctx: ProactiveContext,
    repo: IProactiveStateRepository
  ) => Promise<void>
}

/**
 * Gating and content-building for an existing proactive row: the cooldown
 * check, re-validation before it is shown, and the (mutexed) rebuild of a
 * stale body.
 */
export function createProactivePrep(deps: { app: Pick<Lectorium, "repositories"> }): ProactivePrep {
  /** Mutex keyed by `ruleKind|ruleDate`. Held during prep so the next tick
   *  doesn't double-call an in-flight LLM/template build. */
  const inFlight = new Set<string>()

  function mutexKey(ruleKind: string, ruleDate: string): string {
    return `${ruleKind}|${ruleDate}`
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
    const stale = isPrepStale(entry, rule.config.refresh_if_older_than_hours, ctx.nowMs)
    if (!stale && entry.prepState === "ready") return

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
        deps.app.repositories().tracks
      )
      await repo.updateContent(entry.chatMessageId, scrubbed.bodyMd, scrubbed.actions, result.cites)
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
      await deps.app
        .repositories()
        .chatSessions.touch(entry.sessionId, ctx.nowMs)
        .catch(() => undefined)
      // The row just flipped to ready/degraded — listUnseenSessionIds
      // filters out `pending` rows, so without this emit the badge
      // would stay dark until something else (next 30-min tick, app
      // resume, user nav to chat) triggers a refresh.
      emit("row-prepped")
    } catch (err) {
      console.warn("[proactive] buildContent threw", rule.config.id, err)
      await repo.updatePrepState(entry.chatMessageId, "degraded", ctx.nowMs).catch(() => undefined)
      emit("row-prepped")
    } finally {
      inFlight.delete(key)
    }
  }

  return { isOnCooldown, reValidateRow, prepIfStale }
}
