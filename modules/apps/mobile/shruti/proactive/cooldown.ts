import type { ProactivePrepState } from "@lib/domain/ports/proactiveStateRepository.js"

/** The cooldown-relevant slice of a resolved rule's config. */
export interface CooldownConfig {
  /** Hours a rule waits after its most recent non-pending instance
   *  before it may fire again. `<= 0` disables cooldown entirely. */
  readonly cooldown_hours: number
  /** Shorter cooldown that applies only after the user explicitly
   *  dismissed the previous instance (a soft upsell may return sooner
   *  than the "seen & accepted" path). */
  readonly dismiss_resets_after_hours?: number
}

/** The cooldown-relevant slice of the most-recent instance of a rule. */
export interface CooldownLastInstance {
  readonly prepState: ProactivePrepState
  readonly createdAt: number
}

/**
 * Pure cooldown rule: is `rule` still cooling down at `nowMs`, given its
 * most-recent instance (or `undefined` if it never fired)? `pending` /
 * `superseded` instances are still in flight and don't gate a new one;
 * `dismissed` uses the (usually shorter) `dismiss_resets_after_hours`
 * window when configured, else the default `cooldown_hours`.
 *
 * Extracted from useProactiveScheduler so the rule is unit-testable
 * without mounting Vue or stubbing the repository.
 */
export function isWithinCooldown(
  config: CooldownConfig,
  last: CooldownLastInstance | undefined,
  nowMs: number
): boolean {
  const cooldownMs = config.cooldown_hours * 3_600_000
  if (cooldownMs <= 0) return false
  if (!last) return false
  if (last.prepState === "pending" || last.prepState === "superseded") return false
  const effectiveCooldownMs =
    last.prepState === "dismissed" && config.dismiss_resets_after_hours !== undefined
      ? config.dismiss_resets_after_hours * 3_600_000
      : cooldownMs
  return nowMs - last.createdAt < effectiveCooldownMs
}
