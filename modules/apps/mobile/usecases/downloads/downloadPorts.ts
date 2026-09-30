import type { TrackId } from "@lib/domain/core.js"
import type { IMediaItemRepository } from "@lib/domain/ports/mediaItemRepository.js"
import type { ITrackRepository } from "@lib/domain/ports/trackRepository.js"
import type { ITranscriptRepository } from "@lib/domain/ports/transcriptRepository.js"
import type { IUnitOfWork } from "@lib/domain/ports/unitOfWork.js"
import type { CdnServer } from "@lib/domain/servers.js"
import type { DownloadMediaError, MediaTransferFn, ScheduleFn } from "./downloadMedia.js"

/**
 * Who asked for a download. `"user"` is a tap someone is waiting on; `"queue"`
 * is the prefetch FIFO working through a playlist on its own. Only the notice
 * rate-limit reads it — the user's own request is never suppressed by the
 * queue's.
 */
export type DownloadOrigin = "user" | "queue"

/**
 * What a track's row shows.
 *
 * `pending` is a tap acknowledged before anything about it is known; it is
 * a claim over whatever the row held, and releasing the claim puts that state
 * back. `deferred` is queued for offline use but held back because the storage
 * budget is spent — neither a failure nor in flight.
 */
export type DownloadState = "idle" | "pending" | "downloading" | "deferred" | "completed" | "failed"

/**
 * Why a download did not happen, as far as the user is concerned.
 *
 * `connectivity` is the two callers that genuinely know it: the offline guard
 * (airplane mode) and the stall watch abandoning a transfer that stopped
 * moving. The rest come straight off `downloadMedia`'s `Result`, minus
 * `cancelled` — a user decision handled before it ever gets here. `unknown` is
 * the catch-all throw.
 */
export type DownloadFailureCause =
  | "connectivity"
  | Exclude<DownloadMediaError, "cancelled">
  | "unknown"

/** The per-track rows the UI draws, as the download flow writes them. */
export interface DownloadRowsPort {
  getState(trackId: TrackId): DownloadState
  /** What a row really is underneath a `pending` claim. */
  effectiveState(trackId: TrackId): DownloadState | undefined
  setState(trackId: TrackId, state: DownloadState): void
  clearState(trackId: TrackId): void
  setProgress(trackId: TrackId, pct: number): void
  markPending(trackId: TrackId): void
  clearPending(trackId: TrackId): void
  markDeferred(trackId: TrackId): void
  markStartingDownload(trackId: TrackId): void
  /** The generation the rows are in; a wipe bumps it. */
  currentEpoch(): number
}

/** The storage budget: what is charged, reserved and still free. */
export interface DownloadBudget {
  readonly isMeasured: boolean
  ensureMeasured(): Promise<void>
  sizeOf(filesize: number | null | undefined): number
  hasRoomFor(bytes: number, exceptTrackId?: TrackId): boolean
  reserve(trackId: TrackId, bytes: number): void
  settle(trackId: TrackId, stored: boolean): void
  adopt(trackId: TrackId, bytes: number): void
  uncharge(trackId: TrackId): void
  forget(trackId: TrackId): void
}

/** What the user is told about a download. */
export interface DownloadNoticesPort {
  announceBudgetFull(downloadAnyway: () => void): void
  announceDownloadFailed(origin: DownloadOrigin, cause: DownloadFailureCause): void
}

/** The platform downloader, keyed by remote url. */
export interface MediaFiles {
  readonly download: MediaTransferFn
  delete(url: string): Promise<void>
  cancel(url: string): Promise<void>
  resolveLocalUrl(url: string): Promise<string | null>
}

/** What the stall watch resolves with; distinct from any real result. */
export const STALLED = Symbol("stalled")

/** Settles once an attempt has gone a whole deadline without a byte. */
export interface StallWatch {
  readonly expired: Promise<typeof STALLED>
  /** Report a byte: restarts the deadline. */
  readonly touch: () => void
  /** Stop watching; the promise then never settles. */
  readonly stop: () => void
}

export interface DownloadRepositories {
  readonly mediaItems: IMediaItemRepository
  readonly tracks: ITrackRepository
  readonly transcripts: ITranscriptRepository
  readonly unitOfWork: IUnitOfWork
}

/** Everything outside the download flow that it reads or drives. */
export interface DownloadPlatform {
  readonly files: MediaFiles
  /** Throws until the databases are open. */
  readonly repositories: () => DownloadRepositories
  readonly activeServer: () => CdnServer
  /** Make the CDN that just delivered the active one. */
  readonly promoteServer: (server: CdnServer) => void
  /** Delete a cached transcript file by its storage path. */
  readonly deleteTranscriptFile: (path: string) => Promise<void>
  /** The item the audio engine has loaded, or `null` when its queue is empty or unreadable. */
  readonly loadedQueueItem: () => Promise<string | null>
  /** Airplane mode: a transfer started now waits for a network that never comes. */
  readonly isOffline: () => boolean
  readonly startStallWatch: () => StallWatch
  /** The hedge's timers. */
  readonly schedule: ScheduleFn
}
