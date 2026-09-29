import type { ProactivePrepState } from "@lib/domain/ports/proactiveStateRepository.js"

/** The cooldown-relevant slice of a resolved rule's config. */
export interface CooldownConfig {
  /** Hours a rule waits after its most recent live instance (pending,
   *  ready or dismissed) before it may fire again. `<= 0` disables
   *  cooldown entirely. */
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
 * most-recent instance (or `undefined` if it never fired)?
 *
 * A `pending` row still gates a new instance. Rules whose `ruleDate` moves
 * between ticks (e.g. `next_shloka`, which keys on the *next* verse's track
 * id) can sit `pending` — `buildContent` returning `null` until the
 * content / library-language data hydrates — and without the gate every
 * 30-min tick would mint another row under a fresh `ruleDate`, each one
 * sailing past `UNIQUE(rule_kind, rule_date)` into its own chat session,
 * until the batch flips to `ready` in a single prep pass and surfaces as N
 * identical cards at once. Gating on `pending` caps a rule to one
 * live instance per cooldown window regardless of prep outcome; a truly
 * stuck row still releases once `cooldown_hours` elapse from its
 * `createdAt`, and the prep loop finishes building it independently.
 *
 * `superseded` still does not gate: it means the instance was actively
 * invalidated (the suggested track was dropped by catalog.publish), so a
 * replacement should be allowed immediately. `dismissed` uses the
 * (usually shorter) `dismiss_resets_after_hours` window when configured,
 * else the default `cooldown_hours`.
 */
export function isWithinCooldown(
  config: CooldownConfig,
  last: CooldownLastInstance | undefined,
  nowMs: number
): boolean {
  const cooldownMs = config.cooldown_hours * 3_600_000
  if (cooldownMs <= 0) return false
  if (!last) return false
  if (last.prepState === "superseded") return false
  const effectiveCooldownMs =
    last.prepState === "dismissed" && config.dismiss_resets_after_hours !== undefined
      ? config.dismiss_resets_after_hours * 3_600_000
      : cooldownMs
  return nowMs - last.createdAt < effectiveCooldownMs
}
