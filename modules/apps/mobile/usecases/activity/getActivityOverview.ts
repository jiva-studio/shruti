import { buildHeatmapDays, type HeatmapDay } from "./buildHeatmapDays.js"
import { computeCurrentStreak } from "./computeCurrentStreak.js"
import { getDailyListeningHeatmap } from "./getDailyListeningHeatmap.js"
import type { PlaylistItemId } from "@lib/domain/core.js"
import type { IListeningSessionRepository } from "@lib/domain/ports/listeningSessionRepository.js"
import type { IPlaylistItemRepository } from "@lib/domain/ports/playlistItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"

export interface GetActivityOverviewInput {
  /** Window edges in unix ms. The caller anchors them on "now". */
  readonly fromMs: number
  readonly toMs: number
  /**
   * Real "now" in unix ms — the anchor for the heatmap's today-cell and
   * for streak computation. Kept separate from `toMs` (which is the
   * query upper bound and sits in the future to include the look-ahead
   * buffer); collapsing the two pushed the today-cell ~225 days into
   * the future and clamped it to the right edge of the grid.
   */
  readonly nowMs: number
  /** Width of the rendered heatmap grid in days. */
  readonly totalDays: number
}

export interface GetActivityOverviewDeps {
  readonly listeningSessions: IListeningSessionRepository
  readonly playlistItems: IPlaylistItemRepository
  readonly tracks: ITrackRepository
}

export interface ActivityOverview {
  readonly days: readonly HeatmapDay[]
  readonly currentStreak: number
  readonly completedCount: number
  readonly totalListenedSeconds: number
}

/**
 * Aggregate the Activity tab's four numbers in one orchestrated call:
 * heatmap grid, current streak, completed-lectures count, total time.
 *
 * Pulled out of `useActivityHeatmap` so the multi-repo glue is testable
 * in isolation and the N+1 hydration that fed completion-detection is
 * collapsed to a single batched `tracks.getByIds`.
 */
export async function getActivityOverview(
  input: GetActivityOverviewInput,
  deps: GetActivityOverviewDeps
): Promise<ActivityOverview> {
  const [totals, totalSec, activeItems, archivedItems] = await Promise.all([
    getDailyListeningHeatmap(
      { fromMs: input.fromMs, toMs: input.toMs },
      { listeningSessions: deps.listeningSessions }
    ),
    deps.listeningSessions.getTotalListenedSeconds(),
    deps.playlistItems.listActive(),
    // Archive only flips `archived_at`; `listening_sessions` is untouched,
    // so a completed lecture the user archived must still contribute to
    // the Activity tab's completedCount. Issue #470 fixed the per-row
    // badge by unioning the two lists in usePlaylistStore; this counter
    // was missed in that pass.
    deps.playlistItems.listArchived(),
  ])

  const allItems = [...activeItems, ...archivedItems]
  const itemIds: PlaylistItemId[] = allItems.map((i) => i.id)
  const trackIds = allItems.map((i) => i.trackId)
  const tracksById = await deps.tracks.getByIds(trackIds)
  const durations = new Map<PlaylistItemId, number>()
  for (const item of allItems) {
    const track = tracksById.get(item.trackId)
    if (!track) continue
    const ms = maxAudioDurationMs(track)
    if (ms > 0) durations.set(item.id, Math.floor(ms / 1000))
  }
  // Lifetime, not per-pass: "lectures completed" is a career total. Re-adding
  // a finished lecture starts a fresh pass on Home, but it must not decrement
  // this counter until the user finishes it again (#1736).
  const everCompleted = await deps.listeningSessions.listEverCompletedItems(itemIds, durations)

  const { days } = buildHeatmapDays(input.totalDays, input.nowMs, totals)
  return {
    days,
    currentStreak: computeCurrentStreak(days),
    completedCount: everCompleted.size,
    totalListenedSeconds: totalSec,
  }
}
