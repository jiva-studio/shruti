import { computed, type ComputedRef } from "vue"
import { buildTrackRow } from "@lectorium/composables/buildTrackRow.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useDownloadStore, type DownloadState } from "@lectorium/stores/useDownloadStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
import type { Track } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"

export interface UseTrackUiStateMapperReturn {
  /** Convert a single domain `Track` into the UI row used by lists. */
  toUiRow: (track: Track) => UiTrackRow
  /** Map a list of domain tracks reactively. Recomputes when downloads,
   *  playlist membership, current playback, or the UI language change. */
  mapRows: (tracks: () => readonly Track[]) => ComputedRef<readonly UiTrackRow[]>
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
      state,
      progressPct,
    })
  }

  function mapRows(tracks: () => readonly Track[]): ComputedRef<readonly UiTrackRow[]> {
    return computed(() => {
      // Touch reactive sources so `computed` re-runs on changes.
      void downloads.states
      void downloads.progress
      void playlist.entries
      void playlist.progressMap
      void playlist.completedAtMap
      void player.trackId
      void player.positionMs
      void player.durationMs
      return tracks().map(toUiRow)
    })
  }

  return { toUiRow, mapRows, toUiState }
}
