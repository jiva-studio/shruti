import type { MediaItemId, TrackId } from "../core.js"
import type { MediaAudioKind, MediaItem, MediaItemState } from "../mediaItem.js"
import type { ITransaction } from "./unitOfWork.js"

export interface IMediaItemRepository {
  /** Fetch one version's row. `kind` defaults to "original". */
  getByTrack(trackId: TrackId, kind?: MediaAudioKind): Promise<MediaItem | null>
  listReady(): Promise<readonly MediaItem[]>
  /**
   * Upsert one version's row. `kind` defaults to "original".
   *
   * The read of the existing row and the write that follows it are one
   * transaction, which is what makes `downloadMedia`'s check-and-claim of the
   * "downloading" slot atomic. `tx`: the caller's open transaction, to join
   * instead of opening a second one — `downloadMedia` claims from inside its
   * own block and must hand the handle down.
   */
  upsert(
    trackId: TrackId,
    state: MediaItemState,
    localPath: string | null,
    kind?: MediaAudioKind,
    tx?: ITransaction
  ): Promise<MediaItem>
  /**
   * Record that a track's cached audio is owed an eviction — the lecture was
   * archived while the native engine could still reach the file. A no-op for a
   * track with no cache row. Cleared by the next `upsert` (a re-download owes
   * nothing) and by the delete that finally reclaims the file.
   */
  markEvictPending(trackId: TrackId): Promise<void>
  /** Cached rows still owing an eviction, across every version. */
  listEvictPending(): Promise<readonly MediaItem[]>
  /** Remove ALL versions (original + clean) of a track. */
  deleteByTrack(trackId: TrackId): Promise<void>
  deleteById(id: MediaItemId): Promise<void>
  clearAll(): Promise<void>
  /**
   * Flip every row in state="downloading" to "failed" with localPath=null,
   * and return the rows as they were BEFORE the demotion. Called on app start
   * to recover from a force-close or crash that left a download mid-flight —
   * without this, `downloadMedia` would refuse to retry such rows with
   * `already-in-progress`.
   *
   * The demotion is a guess, and on iOS often the wrong one: a background
   * `URLSession` goes on delivering while the app is suspended or killed, so
   * the bytes routinely land while the row still says "downloading". Only the
   * disk knows, and this layer cannot ask it — the native cache is addressed
   * by the file's remote key, which is a catalog lookup away. So the rows are
   * handed back for the caller to reconcile (see the download store's
   * `hydrate`), and the pessimistic state is what a caller that does not
   * reconcile is left with.
   */
  failStaleDownloads(): Promise<readonly MediaItem[]>
}
