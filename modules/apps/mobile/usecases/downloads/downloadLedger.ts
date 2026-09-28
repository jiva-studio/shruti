import type { TrackId } from "@lib/domain/core.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"

export interface RecoveredLedger {
  /** Tracks the previous session left mid-transfer, now demoted to failed. */
  readonly staleTrackIds: readonly TrackId[]
  /** Tracks whose audio is saved. */
  readonly readyTrackIds: readonly TrackId[]
}

/**
 * Read the download ledger at the start of a session. A row the previous
 * session left at "downloading" — the app was closed mid-transfer — is demoted
 * first: left alone it keeps the next attempt refused as already-in-progress.
 */
export async function recoverDownloadLedger(deps: {
  readonly mediaItems: IMediaItemRepository
}): Promise<RecoveredLedger> {
  const stale = await deps.mediaItems.failStaleDownloads()
  const ready = await deps.mediaItems.listReady()
  return {
    staleTrackIds: stale.map((item) => item.trackId),
    readyTrackIds: ready.map((item) => item.trackId),
  }
}

/** The tracks whose audio is saved. */
export async function listDownloadedTrackIds(deps: {
  readonly mediaItems: IMediaItemRepository
}): Promise<readonly TrackId[]> {
  return (await deps.mediaItems.listReady()).map((item) => item.trackId)
}

/**
 * What each saved track charges the storage budget. One ledger row exists per
 * (track, kind) but only one version is ever fetched, so a track with both
 * rows is counted once.
 */
export async function measureDownloadedBytes(
  deps: { readonly mediaItems: IMediaItemRepository; readonly tracks: ITrackRepository },
  sizeOf: (filesize: number | null | undefined) => number
): Promise<Map<TrackId, number>> {
  const ready = await deps.mediaItems.listReady()
  const trackIds = [...new Set(ready.map((item) => item.trackId))]
  const sizes = await deps.tracks.getAudioSizesBytes(trackIds)
  const charged = new Map<TrackId, number>()
  for (const trackId of trackIds) charged.set(trackId, sizeOf(sizes.get(trackId)))
  return charged
}

/**
 * Settings → Clear cache: delete the cached audio and transcript files, then
 * the ledger that points at them. Without the ledger wipe every cleared track
 * keeps showing "downloaded" and plays a file that is gone. User records and
 * the content catalog are not cache and are left alone.
 */
export async function clearMediaCache(deps: {
  readonly deleteAllFiles: () => Promise<void>
  /** Resolved after the files are gone, as the wipe always did. */
  readonly mediaItems: () => IMediaItemRepository
}): Promise<void> {
  await deps.deleteAllFiles()
  await deps.mediaItems().clearAll()
}
