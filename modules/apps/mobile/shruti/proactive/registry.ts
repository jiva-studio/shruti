import type { ProactiveRuleConfig, ProactiveRuleId } from "@lib/domain/config.js"
import type { ProactiveRuleHandler, ResolvedProactiveRule } from "./types.js"

/**
 * Bundled fallback configs per rule. Used when `config.json` has no
 * `proactive` block at all, or when it omits a specific rule. Each
 * entry in the published config overrides the bundled default by `id`
 * — `enabled: false` is the kill switch for a single rule.
 *
 * Phase 2 ships an empty registry; subsequent phases register handlers
 * with `registerRule()` from the rule's own module.
 */
const BUNDLED_DEFAULTS: ProactiveRuleConfig[] = [
  {
    id: "enable_notifications_hint",
    enabled: true,
    mode: "pre_baked",
    prep_window_hours: 0,
    refresh_if_older_than_hours: 9999,
    // `new_session`: the autonomous tutorial gets its own chat session
    // (titled after the feature) so the introduction doesn't crash a
    // pre-existing user conversation. The handler emits
    // `sessionTitleOverride` with the localised feature name.
    session_strategy: "new_session",
    cooldown_hours: 720,
    eligibility: [
      { predicate: "current_streak_at_least", value: 3 },
      { predicate: "has_notifications_permission", value: false },
    ],
  },
  {
    id: "smart_library_hint",
    enabled: true,
    mode: "pre_baked",
    prep_window_hours: 0,
    refresh_if_older_than_hours: 9999,
    session_strategy: "new_session",
    cooldown_hours: 720,
    dismiss_resets_after_hours: 2160,
    eligibility: [
      { predicate: "completed_tracks_at_least", value: 3 },
      { predicate: "is_subscribed", value: false },
    ],
  },
  {
    id: "next_shloka",
    enabled: true,
    mode: "pre_baked",
    prep_window_hours: 0,
    refresh_if_older_than_hours: 24,
    session_strategy: "new_session",
    // 24 h so the user gets at most one "next verse" nudge per day
    // even when burning through a series.
    cooldown_hours: 24,
    eligibility: [
      // Skip day-one users who haven't seriously started any series;
      // wait until they have some listening history.
      { predicate: "completed_tracks_at_least", value: 3 },
    ],
  },
  {
    id: "weekly_digest",
    enabled: true,
    mode: "pre_baked",
    prep_window_hours: 12,
    refresh_if_older_than_hours: 6,
    session_strategy: "new_session",
    session_title_template: "Weekly progress",
    cooldown_hours: 144,
    eligibility: [
      { predicate: "total_listened_seconds_at_least", value: 1800 },
      { predicate: "completed_tracks_at_least", value: 2 },
    ],
  },
  {
    id: "inactivity",
    enabled: true,
    mode: "pre_baked",
    prep_window_hours: 0,
    refresh_if_older_than_hours: 24,
    session_strategy: "new_session",
    cooldown_hours: 336,
    eligibility: [
      { predicate: "completed_tracks_at_least", value: 3 },
      { predicate: "days_since_install_at_least", value: 14 },
    ],
  },
  {
    id: "unfinished_lecture",
    enabled: true,
    mode: "pre_baked",
    prep_window_hours: 24,
    refresh_if_older_than_hours: 24,
    session_strategy: "new_session",
    // No eligibility gate: an actually-abandoned lecture is its own
    // signal, and the rule's own `onAppPause` cooldown caps frequency.
    cooldown_hours: 72,
  },
  {
    id: "holiday",
    enabled: true,
    mode: "pre_baked",
    prep_window_hours: 48,
    refresh_if_older_than_hours: 24,
    session_strategy: "new_session",
    session_title_template: "{holiday_name}",
    cooldown_hours: 24,
  },
]

const handlers = new Map<ProactiveRuleId, ProactiveRuleHandler>()

/**
 * Register a rule handler. Called from each rule's module at
 * import-time (e.g., `proactive/rules/enableNotificationsHint.ts`
 * imports for its side effect via the composition root).
 */
export function registerRule(handler: ProactiveRuleHandler): void {
  handlers.set(handler.id, handler)
}

/** Test-only escape hatch. */
export function clearRegistry(): void {
  handlers.clear()
}

/**
 * Resolve every rule we know how to handle, applying remote-config
 * overrides on top of bundled defaults. Rules with `enabled: false`
 * (either explicitly in remote config or via bundled default) are
 * dropped here so the scheduler never sees them.
 */
export function resolveRules(
  remoteRules: readonly ProactiveRuleConfig[] = []
): readonly ResolvedProactiveRule[] {
  const overrides = new Map<ProactiveRuleId, ProactiveRuleConfig>()
  for (const r of remoteRules) overrides.set(r.id, r)

  const resolved: ResolvedProactiveRule[] = []
  for (const def of BUNDLED_DEFAULTS) {
    const config = overrides.get(def.id) ?? def
    if (!config.enabled) continue
    const handler = handlers.get(config.id)
    if (!handler) continue
    resolved.push({ config, handler })
  }
  return resolved
}
