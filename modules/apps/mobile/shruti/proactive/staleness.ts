/** The staleness-relevant slice of a proactive row. */
export interface PrepStalenessInput {
  /** unix MILLISECONDS, or `null` when the body was never built. */
  readonly preparedAt: number | null
}

/**
 * Has `entry`'s prepared body aged past the rule's refresh window at `nowMs`?
 *
 * A never-prepped row (`preparedAt === null`) is stale by definition — that is
 * how a freshly detected `pending` row gets its first body. Everything else is
 * a plain age comparison, which only holds while both sides are the same unit:
 * `attach()` used to stamp unix-SECONDS, making every inline-hint row look
 * ~55 years old and turning `refresh_if_older_than_hours: 9999` into no
 * protection at all (#1770).
 *
 * Extracted from useProactiveScheduler so the rule is unit-testable without
 * mounting Vue or stubbing the repository.
 */
export function isPrepStale(
  entry: PrepStalenessInput,
  refreshIfOlderThanHours: number,
  nowMs: number
): boolean {
  if (entry.preparedAt === null) return true
  return nowMs - entry.preparedAt > refreshIfOlderThanHours * 3_600_000
}
