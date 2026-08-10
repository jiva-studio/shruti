import { computed, type ComputedRef } from "vue"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"
import type { UiPlaybackProgress } from "./types.js"

/** Download states outrank live playback on a row: a re-downloading track
 *  shows its transfer, not the position of the player it happens to be in. */
const DOWNLOAD_STATES: readonly UiTrackState[] = ["pending", "downloading", "failed"]

/**
 * The overlay, but only for the row it actually belongs to — `null` for every
 * other row and for a row whose download outranks playback. Reads
 * `playback.trackId` and nothing else, so a caller that stops here stays
 * independent of the position ticks.
 */
export function livePlaybackFor(
  row: UiTrackRow,
  playback: UiPlaybackProgress | undefined
): UiPlaybackProgress | null {
  if (!playback || playback.trackId !== row.id) return null
  if (DOWNLOAD_STATES.includes(row.state)) return null
  return playback
}

export interface PlaybackRowState {
  readonly state: ComputedRef<UiTrackState>
  readonly progressPct: ComputedRef<number>
}

/**
 * What a playlist row should SHOW, given its (position-free) built row and the
 * live playback overlay.
 *
 * The point is what it reads: `playback.trackId` always, `playback.state` and
 * `playback.progressPct` only when this row is the track the player is on. So
 * a position tick invalidates the computeds of exactly one row — the rest of
 * the list stays clean, and nothing above it (the row-building computed, the
 * grouping computed, the list component) re-runs at all. Issue #1504.
 */
export function usePlaybackRowState(
  row: () => UiTrackRow,
  playback: () => UiPlaybackProgress | undefined
): PlaybackRowState {
  const live = computed<UiPlaybackProgress | null>(() => livePlaybackFor(row(), playback()))

  return {
    state: computed(() => live.value?.state ?? row().state),
    progressPct: computed(() => live.value?.progressPct ?? row().progressPct),
  }
}
