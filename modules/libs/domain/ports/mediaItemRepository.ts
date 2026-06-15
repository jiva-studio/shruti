import type { MediaItemId, TrackId } from "../core.js"
import type { MediaAudioKind, MediaItem, MediaItemState } from "../mediaItem.js"

export interface IMediaItemRepository {
  /** Fetch one version's row. `kind` defaults to "original". */
  getByTrack(trackId: TrackId, kind?: MediaAudioKind): Promise<MediaItem | null>
  listReady(): Promise<readonly MediaItem[]>
  /** Upsert one version's row. `kind` defaults to "original". */
  upsert(
    trackId: TrackId,
    state: MediaItemState,
    localPath: string | null,
    kind?: MediaAudioKind
  ): Promise<MediaItem>
  /** Remove ALL versions (original + clean) of a track. */
  deleteByTrack(trackId: TrackId): Promise<void>
  deleteById(id: MediaItemId): Promise<void>
  clearAll(): Promise<void>
  /**
   * Flip every row in state="downloading" to "failed" with localPath=null.
   * Called on app start to recover from a force-close or crash that left
   * a download mid-flight — without this, `downloadMedia` would refuse to
   * retry such rows with `already-in-progress`.
   */
  failStaleDownloads(): Promise<void>
}
