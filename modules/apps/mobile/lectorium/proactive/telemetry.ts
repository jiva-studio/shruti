import type { IPreferences } from "@ports/app/preferences.js"
import type { ProactiveRuleId } from "@lib/domain/config.js"

/**
 * Lifecycle events worth counting per rule. Local-only — nothing
 * leaves the device. Surfaced through a dev-only Settings panel for
 * sanity-checking which rules actually fire in real usage.
 */
export type ProactiveTelemetryEvent =
  | "detected"
  | "ready"
  | "degraded"
  | "superseded"
  | "notified"

function key(rule: ProactiveRuleId, event: ProactiveTelemetryEvent): string {
  return `proactive.telemetry.${rule}.${event}`
}

/** Best-effort increment. Failures are swallowed — counters are
 *  insight-only, never on the hot path. */
export async function recordEvent(
  prefs: IPreferences,
  rule: ProactiveRuleId,
  event: ProactiveTelemetryEvent
): Promise<void> {
  try {
    const raw = await prefs.get(key(rule, event))
    const n = raw ? Number(raw) : 0
    await prefs.set(key(rule, event), String(Number.isFinite(n) ? n + 1 : 1))
  } catch {
    // ignore
  }
}

export async function readCounter(
  prefs: IPreferences,
  rule: ProactiveRuleId,
  event: ProactiveTelemetryEvent
): Promise<number> {
  try {
    const raw = await prefs.get(key(rule, event))
    if (raw === null) return 0
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}
