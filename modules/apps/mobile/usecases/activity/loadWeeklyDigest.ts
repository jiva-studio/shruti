import type { TrackId } from "@lib/domain/core.js"
import type {
  DayOffsetListeningTotal,
  TrackListeningTotal,
} from "@lib/domain/ports/listeningSessionRepository.js"
import type { Track } from "@lib/domain/track.js"
import {
  getActivityOverview,
  type ActivityOverview,
  type GetActivityOverviewDeps,
} from "./getActivityOverview.js"

export interface WeeklyDigest {
  /** Seconds per whole day from the window start. */
  readonly dailyTotals: readonly DayOffsetListeningTotal[]
  /** Lectures listened in the window, most listened first. */
  readonly lectures: readonly TrackListeningTotal[]
  /** Their tracks, as far as the catalog carries them. */
  readonly tracksById: ReadonlyMap<TrackId, Track>
  /** The streak is a rolling property of the whole history; the completed
   *  count comes from the window. */
  readonly overview: ActivityOverview
}

/** What the weekly-digest card shows for the week `[fromMs, toMs)`. */
export async function loadWeeklyDigest(
  input: { readonly fromMs: number; readonly toMs: number; readonly nowMs: number },
  deps: GetActivityOverviewDeps
): Promise<WeeklyDigest> {
  const { fromMs, toMs, nowMs } = input
  const [dailyTotals, lectures, overview] = await Promise.all([
    deps.listeningSessions.getDailyTotalsByDayOffset(fromMs, toMs),
    deps.listeningSessions.getTracksListenedInRange(fromMs, toMs),
    getActivityOverview({ fromMs, toMs, nowMs, totalDays: 7 }, deps),
  ])
  const tracksById = await deps.tracks.getByIds(lectures.map((r) => r.trackId))
  return { dailyTotals, lectures, tracksById, overview }
}
