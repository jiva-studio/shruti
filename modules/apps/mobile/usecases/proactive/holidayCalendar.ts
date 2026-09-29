import type { HolidayEntry } from "@lib/domain/config.js"
import type { IClock } from "@lib/domain/ports/clock.js"

/** The calendar is content-published, so within a session it changes only
 *  through a background config refresh, at most hourly. */
const CALENDAR_TTL_MS = 60_000

/**
 * The holiday calendar, read at most once a minute: a tick asks for it from
 * detect, validate and buildContent in turn. A failed read reads as an empty
 * calendar and is not remembered, so the next call retries.
 */
export function createHolidayCalendar(
  load: () => Promise<readonly HolidayEntry[]>,
  clock: IClock
): () => Promise<readonly HolidayEntry[]> {
  let cache: { at: number; data: readonly HolidayEntry[] } | null = null
  return async () => {
    const now = clock.now()
    if (cache && now - cache.at < CALENDAR_TTL_MS) return cache.data
    try {
      const data = await load()
      cache = { at: now, data }
      return data
    } catch {
      // Offline or no config cached yet: no holiday fires this tick.
      return []
    }
  }
}
