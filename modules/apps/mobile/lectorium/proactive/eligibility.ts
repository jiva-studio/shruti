import type { EligibilityPredicate } from "@lib/domain/config.js"
import type { ProactiveContext } from "./types.js"

const MS_PER_DAY = 86_400_000

/**
 * Evaluate one predicate against the captured context. Pure — no side
 * effects, no IO. Tests live alongside this file.
 */
export function evaluatePredicate(
  predicate: EligibilityPredicate,
  ctx: ProactiveContext
): boolean {
  switch (predicate.predicate) {
    case "total_listened_seconds_at_least":
      return ctx.totalListenedSeconds >= predicate.value
    case "current_streak_at_least":
      return ctx.currentStreak >= predicate.value
    case "completed_tracks_at_least":
      return ctx.completedTracks >= predicate.value
    case "has_notifications_permission":
      return ctx.hasNotificationsPermission === predicate.value
    case "is_subscribed":
      return ctx.isSubscribed === predicate.value
    case "days_since_install_at_least": {
      if (ctx.firstSeenAtMs === null) return false
      const days = Math.floor((ctx.nowMs - ctx.firstSeenAtMs) / MS_PER_DAY)
      return days >= predicate.value
    }
  }
}

/**
 * AND across the predicate list. Empty / undefined list is treated as
 * "always eligible" — the rule's detector is the only gate.
 */
export function isEligible(
  predicates: readonly EligibilityPredicate[] | undefined,
  ctx: ProactiveContext
): boolean {
  if (!predicates || predicates.length === 0) return true
  for (const p of predicates) {
    if (!evaluatePredicate(p, ctx)) return false
  }
  return true
}
