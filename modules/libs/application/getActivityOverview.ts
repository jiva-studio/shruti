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
  const now = input.toMs
  const [totals, totalSec, activeItems] = await Promise.all([
    getDailyListeningHeatmap(
      { fromMs: input.fromMs, toMs: input.toMs },
      { listeningSessions: deps.listeningSessions }
    ),
    deps.listeningSessions.getTotalListenedSeconds(),
    deps.playlistItems.listActive(),
  ])

  const itemIds: PlaylistItemId[] = activeItems.map((i) => i.id)
  const trackIds = activeItems.map((i) => i.trackId)
  const tracksById = await deps.tracks.getByIds(trackIds)
  const durations = new Map<PlaylistItemId, number>()
  for (const item of activeItems) {
    const track = tracksById.get(item.trackId)
    if (!track) continue
    const ms = maxAudioDurationMs(track)
    if (ms > 0) durations.set(item.id, Math.floor(ms / 1000))
  }
  const completedMap = await deps.listeningSessions.getCompletedAtForItems(itemIds, durations)

  const { days } = buildHeatmapDays(input.totalDays, now, totals)
  return {
    days,
    currentStreak: computeCurrentStreak(days),
    completedCount: Array.from(completedMap.values()).filter((v) => v !== null).length,
    totalListenedSeconds: totalSec,
  }
}
