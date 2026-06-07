import type { CdnServer } from "./servers.js"

/**
 * Remote config published at `{server}/public/config.json` and fetched
 * on every cold start / background refresh.
 */
export interface RemoteAppConfig {
  readonly databases: readonly RemoteDbEntry[]
  readonly proactive?: ProactiveConfig
  /**
   * CDN/region endpoints, managed server-side via shruti-mcp
   * (`catalog.config.regions.*`). When present (and non-empty), this list
   * fully REPLACES the bundled `SERVERS` bootstrap — see
   * `shruti/services/regionsRegistry.ts`. Same shape as the compiled-in
   * `CdnServer` so it drops straight in with no mapping. Omitted/empty →
   * the client keeps its current (bundled or last-persisted) list.
   */
  readonly regions?: readonly CdnServer[]
}

export interface RemoteDbEntry {
  /** Timestamp-ish version, e.g. 20260419120000 (YYYYMMDDHHmmss). */
  readonly version: number
  /** Scheme number (YYYYMMDD) this DB satisfies. */
  readonly scheme?: number
}

/**
 * Rule kinds for agent-initiated (proactive) chat messages. Each kind has
 * a matching detector / validator / content-builder in `proactive/` on
 * the mobile side and (for backend-driven kinds) a system-prompt builder
 * in `agent/proactive_builders/` on the chat service.
 */
export type ProactiveRuleId =
  | "holiday"
  | "weekly_digest"
  | "inactivity"
  | "enable_notifications_hint"
  | "smart_library_hint"
  | "next_shloka"
  | "unfinished_lecture"

/**
 * Config block for the agent's proactive subsystem. Absent or
 * `master_enabled === false` disables everything; per-rule `enabled`
 * disables individual rules. Anything not in `rules` falls back to the
 * bundled defaults compiled into the app.
 */
export interface ProactiveConfig {
  readonly master_enabled?: boolean
  readonly rules: readonly ProactiveRuleConfig[]
  readonly calendars: ProactiveCalendars
}

export interface ProactiveCalendars {
  readonly holidays: readonly HolidayEntry[]
}

export interface ProactiveRuleConfig {
  readonly id: ProactiveRuleId
  readonly enabled: boolean
  /** `pre_baked` (default): body_md is generated ahead of `visible_on`
   *  during a foreground tick. `lazy`: only the row exists ahead of
   *  time; body_md is generated on first display. */
  readonly mode: "pre_baked" | "lazy"
  /** How many hours before `visible_on` we start preparing. */
  readonly prep_window_hours: number
  /** Re-prep if `prepared_at` is older than this many hours. */
  readonly refresh_if_older_than_hours: number
  readonly session_strategy: "new_session" | "append_current" | "system_session"
  /** Mustache-like `{var}` placeholders filled from detector context. */
  readonly session_title_template?: string
  /** Minimum hours between two firings of this rule. */
  readonly cooldown_hours: number
  /** If set, a dismissed instance becomes eligible to fire again after
   *  this many hours. Omit for "dismiss forever". */
  readonly dismiss_resets_after_hours?: number
  /** All predicates must hold (AND). Empty/omitted = always eligible. */
  readonly eligibility?: readonly EligibilityPredicate[]
}

/**
 * Predicates evaluated locally on the device before a rule's detector
 * runs. Lets us hold off `weekly_digest` until the user has actually
 * listened to anything, suppress `enable_notifications_hint` once
 * permission is granted, etc.
 */
export type EligibilityPredicate =
  | { readonly predicate: "total_listened_seconds_at_least"; readonly value: number }
  | { readonly predicate: "current_streak_at_least"; readonly value: number }
  | { readonly predicate: "completed_tracks_at_least"; readonly value: number }
  | { readonly predicate: "has_notifications_permission"; readonly value: boolean }
  | { readonly predicate: "is_subscribed"; readonly value: boolean }
  | { readonly predicate: "days_since_install_at_least"; readonly value: number }

export interface HolidayEntry {
  readonly id: string
  /** Per-locale display names, e.g. `{ en: "Janmashtami", ru: "Джанмаштами" }`. */
  readonly name: Record<string, string>
  /** Local date the holiday falls on, `'YYYY-MM-DD'`. */
  readonly date: string
}
