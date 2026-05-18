import { computed, type ComputedRef } from "vue"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import { useDownloadStore } from "@lectorium/stores/useDownloadStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import { useTrackUiStateMapper } from "@lectorium/composables/useTrackUiStateMapper.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"

export interface HomeRowBuilderReturn {
  rows: ComputedRef<readonly UiTrackRow[]>
  queueCount: ComputedRef<number>
  queueTotalSeconds: ComputedRef<number>
}

/**
 * Derives the Home view's row list and queue summary from the playlist
 * store. Row state + progress come from the shared
 * `useTrackUiStateMapper` (single source of truth for state precedence
 * across Home / Search / Library); Home layers its own `disabled` and
 * `dimmed` flags on top so an in-flight download is non-interactive and
 * the failed-state row dims to read as "something is off."
 */
export function useHomeRowBuilder(): HomeRowBuilderReturn {
  const playlist = usePlaylistStore()
  const downloads = useDownloadStore()
  const mapper = useTrackUiStateMapper()

  const rows = computed<readonly UiTrackRow[]>(() => {
    void downloads.states
    void playlist.entries
    return playlist.entries.map(({ track }) => {
      const row = mapper.toUiRow(track)
      // Home is a playlist surface: a track that's been added but never
      // played should show the empty/in-progress radial, NOT the "added"
      // checkmark (checkmark belongs on Library / Search).
      const state = row.state === "added" ? "queued" : row.state
      const disabled = state === "downloading"
      // Dim any row whose audio isn't actually on disk yet — "downloading"
      // and "failed" obviously, but also "idle" rows that carry a saved
      // listening percentage from a previous session. Without this, a
      // queued track with progress > 0 renders at full opacity even
      // though the file hasn't been downloaded yet, contradicting the
      // "ready to play" cue the user reads from a vivid row.
      const dimmed = downloads.getState(track.id) !== "completed"
      return { ...row, state, disabled, dimmed }
    })
  })

  // Queue summary for the "Up Next" header badges — counts only
  // lectures the user hasn't finished yet, and sums their REMAINING
  // duration. Already-completed entries can linger in the list for a
  // while; they shouldn't inflate the "still to listen" count.
  const queueCount = computed(() => {
    let count = 0
    for (const { item } of playlist.entries) {
      if (playlist.getCompletedAt(item.id) === null) count++
    }
    return count
  })

  const queueTotalSeconds = computed(() => {
    let total = 0
    for (const { item, track } of playlist.entries) {
      if (playlist.getCompletedAt(item.id) !== null) continue
      const durMs = maxAudioDurationMs(track)
      if (durMs <= 0) continue
      const progressMs = playlist.getProgressMs(item.id)
      const remainingMs = Math.max(0, durMs - progressMs)
      total += Math.floor(remainingMs / 1000)
    }
    return total
  })

  return { rows, queueCount, queueTotalSeconds }
}
