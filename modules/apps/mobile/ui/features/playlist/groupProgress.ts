import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import { livePlaybackFor } from "./usePlaybackRowState.js"
import type { UiPlaybackProgress } from "./types.js"

/**
 * Listening progress (0–100) averaged over a group's lectures.
 *
 * Scored from `listenedPct`, never from `state`: state carries the transfer
 * too, so a completed lecture being re-downloaded still counts as listened.
 * The live overlay can only raise a row's score, never lower it.
 */
export function groupProgressPct(
  rows: readonly UiTrackRow[],
  playback: UiPlaybackProgress | undefined
): number {
  if (rows.length === 0) return 0
  let sum = 0
  for (const row of rows) {
    const live = livePlaybackFor(row, playback)
    const listened = row.listenedPct ?? (row.state === "completed" ? 100 : 0)
    sum += Math.max(listened, live?.progressPct ?? 0)
  }
  return Math.round(sum / rows.length)
}
