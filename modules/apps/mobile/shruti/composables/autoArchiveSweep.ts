import { maxAudioDurationMs, type Track } from "@lib/domain/track.js"
import type { PlaylistItemId, TrackId } from "@lib/domain/core.js"

/**
 * User-facing key for the auto-archive delay setting. Read by Settings
 * and by this composable so both stay in lockstep.
 */
export const AUTO_ARCHIVE_DELAY_KEY = "settings.autoArchiveDelay"

/**
 * The last delay the user picked while Smart Library was on. Kept apart from
 * {@link AUTO_ARCHIVE_DELAY_KEY}, which the master switch forces to `"off"`,
 * so an off/on cycle can restore the schedule instead of forgetting it. Read
 * and written by the Settings dialog only — the sweep itself never consults it.
 */
export const AUTO_ARCHIVE_LAST_DELAY_KEY = "settings.autoArchiveLastDelay"

export type AutoArchiveDelay = "off" | "immediate" | "8h" | "1d" | "2d" | "3d"

const DAY_MS = 86_400_000

/**
 * Convert the user's chosen bucket into milliseconds. `"off"` is exposed
 * as `null` so callers can branch on a single nullish check rather than
 * a sentinel value.
 */
export function autoArchiveDelayMs(value: AutoArchiveDelay): number | null {
  switch (value) {
    case "off":
      return null
    case "immediate":
      return 0
    case "8h":
      return 8 * 3_600_000
    case "1d":
      return DAY_MS
    case "2d":
      return 2 * DAY_MS
    case "3d":
      return 3 * DAY_MS
  }
}

/**
 * Archiving is the destructive half of Smart Library — it deletes downloaded
 * audio — so it runs only while the master switch (the auto-download target)
 * is on, whatever a stale delay says.
 */
export function isAutoArchiveActive(delay: AutoArchiveDelay, targetSeconds: number): boolean {
  return targetSeconds > 0 && autoArchiveDelayMs(delay) !== null
}

export interface AutoArchiveSweepDeps {
  listActive: () => Promise<readonly { id: PlaylistItemId; trackId: TrackId }[]>
  getTracks: (ids: readonly TrackId[]) => Promise<ReadonlyMap<TrackId, Track>>
  getCompletedAt: (
    itemIds: readonly PlaylistItemId[],
    durations: ReadonlyMap<PlaylistItemId, number>
  ) => Promise<ReadonlyMap<PlaylistItemId, number | null>>
  /**
   * Archive one item, teardown included: leaving the live native queue and
   * reclaiming the cached audio are the archive path's job, not the sweep's.
   * Deleting a file the engine still holds strands playback.
   */
  archive: (itemId: PlaylistItemId) => Promise<unknown>
  now: () => number
}

/**
 * Idempotent sweep: archive every active playlist item whose first
 * "completed" listening session is at least `delay` old. Pure reads on
 * the playlist + sessions repos plus one archive call per candidate;
 * safe to call repeatedly.
 *
 * Skips the DB round-trip when the setting is `"off"`.
 */
export async function runAutoArchiveSweep(
  delay: AutoArchiveDelay,
  deps: AutoArchiveSweepDeps
): Promise<readonly PlaylistItemId[]> {
  const delayMs = autoArchiveDelayMs(delay)
  if (delayMs === null) return []

  const items = await deps.listActive()
  if (items.length === 0) return []

  const trackIds = items.map((i) => i.trackId)
  const tracks = await deps.getTracks(trackIds)
  const durations = new Map<PlaylistItemId, number>()
  for (const it of items) {
    const track = tracks.get(it.trackId)
    if (!track) continue
    const ms = maxAudioDurationMs(track)
    if (ms > 0) durations.set(it.id, Math.floor(ms / 1000))
  }

  const completedAtSec = await deps.getCompletedAt(
    items.map((i) => i.id),
    durations
  )
  const now = deps.now()
  const archived: PlaylistItemId[] = []
  for (const item of items) {
    const sec = completedAtSec.get(item.id)
    if (sec === null || sec === undefined) continue
    if (now - sec * 1000 >= delayMs) {
      await deps.archive(item.id)
      archived.push(item.id)
    }
  }
  return archived
}
