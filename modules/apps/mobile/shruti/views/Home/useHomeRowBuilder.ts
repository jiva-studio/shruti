import { computed, type ComputedRef, type Ref } from "vue"
import { buildTrackRow } from "@shruti/composables/buildTrackRow.js"
import { maxAudioDurationMs } from "@shruti/composables/trackDuration.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import type { LanguageCode } from "@lib/domain/core.js"
import type { Track } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"

export interface HomeRowBuilderReturn {
  rows: ComputedRef<readonly UiTrackRow[]>
  queueCount: ComputedRef<number>
  queueTotalSeconds: ComputedRef<number>
}

/**
 * Derives the Home view's row list and queue summary from the four
 * stores it depends on (player, playlist, downloads, dictionaries).
 *
 * Per-row state precedence (highest first):
 *  - "downloading" — active download (radial with download %).
 *  - "failed"      — download failed (warning icon).
 *  - "playing"     — currently-active player track (radial with playback %).
 *  - "completed"   — listened to the end (double check).
 *  - "queued"      — everything else, including a fully-downloaded track
 *                    that hasn't been played yet — empty/in-progress radial,
 *                    NOT the "added" checkmark. The checkmark belongs on
 *                    the Library / Search list, not Home.
 */
export function useHomeRowBuilder(appLanguage: Ref<LanguageCode>): HomeRowBuilderReturn {
  const player = usePlayerStore()
  const playlist = usePlaylistStore()
  const downloads = useDownloadStore()
  const dictionaries = useDictionariesStore()

  function rowState(trackId: string, completedAt: number | null): UiTrackState {
    const dl = downloads.getState(trackId)
    if (dl === "downloading") return "downloading"
    if (dl === "failed") return "failed"
    if (player.trackId === trackId) return "playing"
    if (completedAt !== null) return "completed"
    return "queued"
  }

  function rowProgressPct(
    track: Track,
    trackId: string,
    state: UiTrackState,
    savedProgressMs: number
  ): number {
    if (state === "downloading") return downloads.getProgress(trackId)
    if (state === "playing") {
      if (player.durationMs <= 0) return 0
      return Math.min(100, Math.max(0, (player.positionMs / player.durationMs) * 100))
    }
    if (state === "queued") {
      const duration = maxAudioDurationMs(track)
      if (duration <= 0) return 0
      return Math.min(100, Math.max(0, (savedProgressMs / duration) * 100))
    }
    return 0
  }

  const rows = computed<readonly UiTrackRow[]>(() => {
    void player.trackId
    void player.positionMs
    void player.durationMs
    void downloads.states
    void downloads.progress
    return playlist.entries.map(({ item, track }) => {
      const completedAt = playlist.getCompletedAt(item.id)
      const state = rowState(track.id, completedAt)
      const savedProgressMs =
        player.itemId === item.id ? player.positionMs : playlist.getProgressMs(item.id)
      const progressPct = rowProgressPct(track, track.id, state, savedProgressMs)
      // Dim + non-interactive while a download is in flight for this row
      // — the radial download indicator is showing, the row is "busy".
      const disabled = state === "downloading"
      return buildTrackRow(track, {
        preferredLanguage: appLanguage.value,
        authorsById: dictionaries.authorsById,
        locationsById: dictionaries.locationsById,
        sourcesById: dictionaries.sourcesById,
        state,
        progressPct,
        disabled,
      })
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
