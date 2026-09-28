/** The staleness-relevant slice of a proactive row. */
export interface PrepStalenessInput {
  /** unix milliseconds, or `null` when the body was never built. */
  readonly preparedAt: number | null
}

/**
 * Has `entry`'s prepared body aged past the rule's refresh window at `nowMs`?
 *
 * A never-prepped row (`preparedAt === null`) is stale by definition — that is
 * how a freshly detected `pending` row gets its first body. Everything else is
 * a plain age comparison, which only holds while both sides are the same unit:
 * a unix-seconds stamp makes every inline-hint row look ~55 years old and
 * turns `refresh_if_older_than_hours: 9999` into no protection at all.
 */
export function isPrepStale(
  entry: PrepStalenessInput,
  refreshIfOlderThanHours: number,
  nowMs: number
): boolean {
  if (entry.preparedAt === null) return true
  return nowMs - entry.preparedAt > refreshIfOlderThanHours * 3_600_000
}
