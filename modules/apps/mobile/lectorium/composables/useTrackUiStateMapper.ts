import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { buildTrackRow } from "@lectorium/composables/buildTrackRow.js"
import { formatListeningDuration } from "@lectorium/composables/formatListeningDuration.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@lectorium/composables/useLibraryLanguages.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useDownloadStore, type DownloadState } from "@lectorium/stores/useDownloadStore.js"
import { usePlayerStore } from "@lectorium/stores/usePlayerStore.js"
import { usePlaylistStore } from "@lectorium/stores/usePlaylistStore.js"
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
  const libraryLanguages = useLibraryLanguages()
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

    // Lifetime "listened" badge — but not once the track is re-added: the new
    // item has its own fresh progress (LECTORIUM-18/19).
    if (!playlist.hasTrack(trackId) && playlist.hasCompletedTrack(trackId)) return "completed"

    if (playlist.hasTrack(trackId)) return "added"
    return "none"
  }

  /**
   * Discovery-surface state (Search / Library). Same outcome as `toUiState`
   * with the discovery fold applied, but deliberately does NOT read
   * `player.positionMs` / `player.durationMs`: those surfaces collapse the
   * progress states to the binary "added" / "completed" badge, so the exact
   * playback position is irrelevant. Reading it would make the row computed
   * re-run on every playback tick (several times a second) and needlessly
   * re-render the whole Search page during playback.
   */
  function toDiscoveryState(trackId: string, downloadState: DownloadState): UiTrackState {
    if (downloadState === "downloading") return "downloading"
    if (downloadState === "failed") return "failed"
    // Currently-playing track → "playing", which folds to added/completed here.
    if (player.trackId === trackId) {
      return playlist.hasCompletedTrack(trackId) ? "completed" : "added"
    }
    const entry = playlist.getEntryByTrackId(trackId)
    if (entry && playlist.getCompletedAt(entry.item.id) != null) return "completed"
    // Saved progress → "queued", which also folds to added/completed.
    if (entry && playlist.getProgressMs(entry.item.id) > 0) {
      return playlist.hasCompletedTrack(trackId) ? "completed" : "added"
    }
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
      contentLanguages: libraryLanguages.value,
      authorsById: dictionaries.authorsById,
      locationsById: dictionaries.locationsById,
      sourcesById: dictionaries.sourcesById,
      tagsById: dictionaries.tagsById,
      formatDuration: (ms) => formatListeningDuration(ms / 1000, t),
      state,
      progressPct,
    })
  }

  /**
   * Discovery-surface row: state via `toDiscoveryState` (no playback position),
   * progress only for an active download — the playing/queued progress radial
   * belongs to the Home playlist view, not Search/Library.
   */
  function toDiscoveryRow(track: Track): UiTrackRow {
    const state = toDiscoveryState(track.id, downloads.getState(track.id))
    const progressPct = state === "downloading" ? downloads.getProgress(track.id) : 0
    return buildTrackRow(track, {
      preferredLanguage: appLanguage.value,
      contentLanguages: libraryLanguages.value,
      authorsById: dictionaries.authorsById,
      locationsById: dictionaries.locationsById,
      sourcesById: dictionaries.sourcesById,
      tagsById: dictionaries.tagsById,
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
      // Touch reactive sources so `computed` re-runs on changes. Discovery
      // surfaces deliberately omit player.positionMs / player.durationMs:
      // they fold the progress states to a binary badge, so re-running on
      // every playback tick would only thrash the render.
      void downloads.states
      void downloads.progress
      void playlist.entries
      void playlist.progressMap
      void playlist.completedAtMap
      void playlist.completedTrackIds
      void player.trackId
      if (discovery) return tracks().map(toDiscoveryRow)
      void player.positionMs
      void player.durationMs
      return tracks().map(toUiRow)
    })
  }

  return { toUiRow, mapRows, toUiState }
}
