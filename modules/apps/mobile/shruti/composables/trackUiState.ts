import type { DownloadState } from "@shruti/stores/useDownloadStore.js"
import type { UiTrackState } from "@ui/components/tracks/list/index.js"

/**
 * What a row's state is derived from. Deliberately position-free: a row is
 * built from data that changes when the user acts, never at the playback tick
 * rate.
 *
 * `inPlaylist` is playlist membership; `entryCompleted` / `entryStarted`
 * describe the CURRENT playlist item, while `everCompleted` is the lifetime
 * badge that survives removal.
 */
export interface TrackListeningFacts {
  readonly downloadState: DownloadState
  readonly isCurrentTrack: boolean
  readonly inPlaylist: boolean
  readonly entryCompleted: boolean
  readonly entryStarted: boolean
  readonly everCompleted: boolean
}

const DOWNLOAD_STATES: Partial<Record<DownloadState, UiTrackState>> = {
  pending: "pending",
  downloading: "downloading",
  failed: "failed",
}

/**
 * State precedence (highest first): pending → downloading / failed →
 * completed → playing → queued → added → none.
 *
 * "playing" wins over "added" / "none" so the row never flashes the wrong
 * indicator; whether the current pass has reached the end is the live
 * overlay's call. The lifetime "listened" badge applies only while the track
 * is out of the playlist — a re-added item has its own fresh progress.
 */
export function deriveUiState(facts: TrackListeningFacts): UiTrackState {
  const downloading = DOWNLOAD_STATES[facts.downloadState]
  if (downloading) return downloading
  if (facts.entryCompleted) return "completed"
  if (facts.isCurrentTrack) return "playing"
  if (facts.entryStarted) return "queued"
  if (!facts.inPlaylist && facts.everCompleted) return "completed"
  return facts.inPlaylist ? "added" : "none"
}

/**
 * Discovery-surface state (Search / Library): {@link deriveUiState} with the
 * progress states folded into the binary "added" / "completed" badge those
 * surfaces show.
 */
export function deriveDiscoveryState(facts: TrackListeningFacts): UiTrackState {
  const downloading = DOWNLOAD_STATES[facts.downloadState]
  if (downloading) return downloading
  const folded: UiTrackState = facts.everCompleted ? "completed" : "added"
  if (facts.isCurrentTrack) return folded
  if (facts.entryCompleted) return "completed"
  if (facts.entryStarted) return folded
  if (facts.everCompleted) return "completed"
  return facts.inPlaylist ? "added" : "none"
}
