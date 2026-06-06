import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { buildTrackRow } from "@shruti/composables/buildTrackRow.js"
import { formatListeningDuration } from "@shruti/composables/formatListeningDuration.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useDownloadStore, type DownloadState } from "@shruti/stores/useDownloadStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import type { Track } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"

export type RowContext = "playlist" | "discovery"

export interface UseTrackUiStateMapperReturn {
  /** Convert a single domain `Track` into the UI row used by lists. */
  toUiRow: (track: Track) => UiTrackRow
  /**
   * Map a list of domain tracks reactively. Recomputes when downloads,
   * playlist membership, current playback, or the UI language change.
   *
   * `context: "discovery"` (Search / Library) folds the playback-progress
   * states (`playing` and `queued`) into the flat `added` state and zeroes
   * the progress bar — discovery surfaces only communicate the binary
   * "in your queue" / "completed" outcome, never a progress radial.
   */
  mapRows: (
    tracks: () => readonly Track[],
    options?: { context?: RowContext }
  ) => ComputedRef<readonly UiTrackRow[]>
  /** Translate raw `DownloadState` + playlist state to the list state. */
  toUiState: (trackId: string, downloadState: DownloadState) => UiTrackState
}

/**
 * Pure mapping layer between the domain `Track` shape and the
 * presentation `UiTrackRow`. Owns the dictionary lookups, download-state
 * interpretation, and the "where is this track in the user's listening
 * journey?" derivation that all track-list views share.
 *
 * State precedence (highest first):
 *  - "downloading" / "failed"  — active download flips to a download
 *    indicator regardless of playlist state.
 *  - "playing"                 — currently-open player track AND playback
 *    position is still short of the end. Re-listening a completed track
 *    goes through this branch again until the new pass reaches the end.
 *  - "completed"               — playlist item carries `completedAt`.
 *    Wins over the bare "player is on this track" check, so a finished
 *    track in the player surfaces on the row without a refresh.
 *  - "queued"                  — in playlist with saved progress > 0.
 *  - "added"                   — in the active playlist, never played.
 *  - "none"                    — not in playlist.
 *
 * The on-disk download cache deliberately does NOT contribute to "added":
 * removing a track from the playlist leaves the cached audio on disk, but
 * the row should fall back to "none" (issue #378).
 */
export function useTrackUiStateMapper(): UseTrackUiStateMapperReturn {
  const { t } = useI18n()
  const appLanguage = useAppLanguage()
  const dictionaries = useDictionariesStore()
  const downloads = useDownloadStore()
  const playlist = usePlaylistStore()
  const player = usePlayerStore()

  function toUiState(trackId: string, downloadState: DownloadState): UiTrackState {
    if (downloadState === "downloading") return "downloading"
    if (downloadState === "failed") return "failed"

    const isPlayerOnThisTrack = player.trackId === trackId
    const playerProgressing =
      isPlayerOnThisTrack && player.durationMs > 0 && player.positionMs < player.durationMs
    if (playerProgressing) return "playing"

    const entry = playlist.getEntryByTrackId(trackId)
    if (entry && playlist.getCompletedAt(entry.item.id) != null) return "completed"

    // Player is on this track but duration/position not yet hydrated —
    // don't fall through to "added" / "none" and flash the wrong indicator.
    if (isPlayerOnThisTrack) return "playing"
    if (entry && playlist.getProgressMs(entry.item.id) > 0) return "queued"

    // Completion across the union of active + archived items. Archive
    // only removes the row from the active list; listening_sessions and
    // the trackId-keyed set are untouched, so the badge survives.
    if (playlist.hasCompletedTrack(trackId)) return "completed"

    if (playlist.hasTrack(trackId)) return "added"
    return "none"
  }

  function progressPctFor(track: Track, state: UiTrackState): number {
    if (state === "downloading") return downloads.getProgress(track.id)
    if (state === "playing") {
      if (player.durationMs <= 0) return 0
      return Math.min(100, Math.max(0, (player.positionMs / player.durationMs) * 100))
    }
    if (state === "queued") {
      const duration = maxAudioDurationMs(track)
      const entry = playlist.getEntryByTrackId(track.id)
      const progress = entry ? playlist.getProgressMs(entry.item.id) : 0
      if (duration <= 0) return 0
      return Math.min(100, Math.max(0, (progress / duration) * 100))
    }
    return 0
  }

  function toUiRow(track: Track): UiTrackRow {
    const state = toUiState(track.id, downloads.getState(track.id))
    const progressPct = progressPctFor(track, state)
    // Search/Library are discovery surfaces — rows always render at full
    // opacity. State is communicated by the indicator alone (radial /
    // red X / check). Dim treatment is reserved for player-context views
    // (Home playlist), which set `disabled`/`dimmed` themselves in
    // `useHomeRowBuilder`.
    return buildTrackRow(track, {
      preferredLanguage: appLanguage.value,
      authorsById: dictionaries.authorsById,
      locationsById: dictionaries.locationsById,
      sourcesById: dictionaries.sourcesById,
      tagNamesById: dictionaries.tagNamesById,
      formatDuration: (ms) => formatListeningDuration(ms / 1000, t),
      state,
      progressPct,
    })
  }

  function mapRows(
    tracks: () => readonly Track[],
    options?: { context?: RowContext }
  ): ComputedRef<readonly UiTrackRow[]> {
    const discovery = options?.context === "discovery"
    return computed(() => {
      // Touch reactive sources so `computed` re-runs on changes.
      void downloads.states
      void downloads.progress
      void playlist.entries
      void playlist.progressMap
      void playlist.completedAtMap
      void playlist.completedTrackIds
      void player.trackId
      void player.positionMs
      void player.durationMs
      const mapped = tracks().map(toUiRow)
      if (!discovery) return mapped
      // Discovery surfaces (Search/Library): collapse playback-progress
      // states to the binary "added"/"completed" badges. Progress radials
      // belong to the Home playlist view only.
      //
      // Re-listen of a completed track: `toUiState` returns "playing" mid-
      // replay (player progresses through the new pass), but on discovery
      // the row should stay "completed" — the user has already finished
      // this lecture. Look up `hasCompletedTrack` to override before the
      // playing/queued → added fold.
      return mapped.map((row) => {
        if (row.state === "playing" || row.state === "queued") {
          if (playlist.hasCompletedTrack(row.id)) {
            return { ...row, state: "completed" as UiTrackState, progressPct: 0 }
          }
          return { ...row, state: "added" as UiTrackState, progressPct: 0 }
        }
        return row
      })
    })
  }

  return { toUiRow, mapRows, toUiState }
}
