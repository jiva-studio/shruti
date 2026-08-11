import { computed, type ComputedRef } from "vue"
import { useI18n } from "vue-i18n"
import { buildTrackRow } from "@shruti/composables/buildTrackRow.js"
import { formatListeningDuration } from "@shruti/composables/formatListeningDuration.js"
import { maxAudioDurationMs } from "@lib/domain/track.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useDownloadStore, type DownloadState } from "@shruti/stores/useDownloadStore.js"
import { usePlayerStore } from "@shruti/stores/usePlayerStore.js"
import { usePlaylistStore } from "@shruti/stores/usePlaylistStore.js"
import type { Track } from "@lib/domain/track.js"
import type { UiTrackRow, UiTrackState } from "@ui/components/tracks/list/index.js"

export type RowContext = "playlist" | "discovery"

export interface UseTrackUiStateMapperReturn {
  /**
   * Convert a single domain `Track` into the UI row used by lists. Takes the
   * same `context` as {@link UseTrackUiStateMapperReturn.mapRows} and means
   * exactly the same thing by it — a row built one at a time is still a row on
   * some surface, and a shelf that omits it renders the same track with a
   * progress radial two sections below a checkmark (#1615).
   */
  toUiRow: (track: Track, options?: { context?: RowContext }) => UiTrackRow
  /**
   * Map a list of domain tracks reactively. Recomputes when downloads,
   * playlist membership, the open player track, or the UI language change —
   * never on a playback position tick (see the header).
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
 *  - "pending"                 — the tap has been accepted and nothing is
 *    known yet. Highest of all: it exists precisely to answer a tap on a
 *    row that already carries some other state.
 *  - "downloading" / "failed"  — active download flips to a download
 *    indicator regardless of playlist state.
 *  - "completed"               — playlist item carries `completedAt`.
 *  - "playing"                 — the player is on this track.
 *  - "queued"                  — in playlist with saved progress > 0.
 *  - "added"                   — in the active playlist, never played.
 *  - "none"                    — not in playlist.
 *
 * NOTHING here reads `player.positionMs` / `player.durationMs`. A row is
 * built from data that changes when the user acts (download, add, complete),
 * never at the playback tick rate — otherwise the one playing row would dirty
 * the whole list computed once a second and every row would be rebuilt
 * (issue #1504). The live position of the ONE track the player is on is a
 * separate, per-field reactive object: `usePlaybackRowProgress`, applied by
 * the row component itself. Two consequences of dropping the position read:
 * a re-listened (completed) track reads "completed" here until the overlay
 * flips it back to "playing", and a "playing" row's radial carries the SAVED
 * playlist progress rather than the live one.
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
    if (downloadState === "pending") return "pending"
    if (downloadState === "downloading") return "downloading"
    if (downloadState === "failed") return "failed"
    // The budget refused to keep this one offline. Without its own state it
    // fell through to "added" and read as saved — a grey row the user takes
    // for downloaded, which then does not play in airplane mode.
    if (downloadState === "deferred") return "deferred"

    const entry = playlist.getEntryByTrackId(trackId)
    if (entry && playlist.getCompletedAt(entry.item.id) != null) return "completed"

    // Player is on this track — never fall through to "added" / "none" and
    // flash the wrong indicator. Whether the current pass has actually
    // reached the end is the live overlay's call, not this computed's.
    if (player.trackId === trackId) return "playing"
    if (entry && playlist.getProgressMs(entry.item.id) > 0) return "queued"

    // Lifetime "listened" badge — but not once the track is re-added: the new
    // item has its own fresh progress (SHRUTI-18/19).
    if (!playlist.hasTrack(trackId) && playlist.hasCompletedTrack(trackId)) return "completed"

    if (playlist.hasTrack(trackId)) return "added"
    return "none"
  }

  /**
   * Discovery-surface state (Search / Library): `toUiState` with the progress
   * states folded into the binary "added" / "completed" badge those surfaces
   * show.
   */
  function toDiscoveryState(trackId: string, downloadState: DownloadState): UiTrackState {
    if (downloadState === "pending") return "pending"
    if (downloadState === "downloading") return "downloading"
    if (downloadState === "failed") return "failed"
    // The budget refused to keep this one offline. Without its own state it
    // fell through to "added" and read as saved — a grey row the user takes
    // for downloaded, which then does not play in airplane mode.
    if (downloadState === "deferred") return "deferred"
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

  /**
   * How much of the lecture the user has listened to, read from the listening
   * data alone — a completed item is 100, anything else its saved position.
   * Deliberately blind to the download state: a row showing "pending" or
   * "downloading" has lost none of its listening history, and a collection
   * ring that scores from `state` discards it the instant the user taps
   * (issue #1615).
   */
  function listenedPctFor(track: Track): number {
    const entry = playlist.getEntryByTrackId(track.id)
    if (!entry) return 0
    if (playlist.getCompletedAt(entry.item.id) != null) return 100
    const duration = maxAudioDurationMs(track)
    if (duration <= 0) return 0
    const progress = playlist.getProgressMs(entry.item.id)
    return Math.min(100, Math.max(0, (progress / duration) * 100))
  }

  function progressPctFor(track: Track, state: UiTrackState): number {
    if (state === "downloading") return downloads.getProgress(track.id)
    // "playing" takes the SAVED progress like "queued" does: the live
    // position belongs to `usePlaybackRowProgress`, which the row component
    // lays over this value for the one track the player is on. The saved
    // value is what the radial shows until the first tick lands, and what a
    // surface without the overlay (Search shelves) keeps showing.
    if (state === "playing" || state === "queued") return listenedPctFor(track)
    return 0
  }

  function toUiRow(track: Track, options?: { context?: RowContext }): UiTrackRow {
    if (options?.context === "discovery") return toDiscoveryRow(track)
    const state = toUiState(track.id, downloads.getState(track.id))
    const progressPct = progressPctFor(track, state)
    const listenedPct = listenedPctFor(track)
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
      listenedPct,
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
      // Touch reactive sources so `computed` re-runs on changes. Playback
      // POSITION is not one of them, in either context — see the header.
      void downloads.states
      void downloads.progress
      void playlist.entries
      void playlist.progressMap
      void playlist.completedAtMap
      void playlist.completedTrackIds
      void player.trackId
      return tracks().map((track) => (discovery ? toDiscoveryRow(track) : toUiRow(track)))
    })
  }

  return { toUiRow, mapRows, toUiState }
}
