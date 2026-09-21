import type { TrackId } from "@lib/domain/core.js"
import type { DownloadOrigin } from "./downloadNotices.js"

export interface TransferHandle {
  readonly trackId: TrackId
  /**
   * Who is waiting on this transfer, boxed so a caller that joins it can
   * upgrade it. Only the failure notice's rate-limit reads it.
   */
  readonly origin: { current: DownloadOrigin }
  /**
   * Aborts the attempt at its next checkpoint. Created before the first await,
   * so a cancel arriving before the native transfer exists still stops it.
   */
  readonly aborter: AbortController
  /** Record the url the transfer was started with, so a cancel can reach it. */
  setUrl(url: string): void
  url(): string | undefined
  /** Give up the slot, unless a newer attempt already owns this track. */
  release(): void
}

export interface InFlightTransfers {
  has(trackId: TrackId): boolean
  /**
   * The running attempt for this track, if any, with its origin raised to the
   * joining caller's. Only ever upwards: a queue job joining a user's transfer
   * changes nothing.
   */
  join(trackId: TrackId, origin: DownloadOrigin): Promise<string | null> | undefined
  /** The running attempt, left exactly as it is — for a caller that only
   *  needs to know when the track is free again. */
  running(trackId: TrackId): Promise<string | null> | undefined
  start(trackId: TrackId, origin: DownloadOrigin): TransferHandle
  adopt(handle: TransferHandle, task: Promise<string | null>): void
  /** Stop a running transfer: abort the task and cancel the native transfer. */
  cancel(trackId: TrackId): void
  abortAll(): void
}

interface Entry {
  readonly handle: TransferHandle
  task: Promise<string | null> | null
  url: string | undefined
}

/**
 * The registry of running download attempts: one slot per track, holding the
 * promise callers join, the abort control, the url a canceller needs and the
 * origin the notices read.
 *
 * A slot is released by identity, never by track id alone — a wipe clears the
 * map and a newer attempt may already own the track by the time an older one
 * settles.
 */
export function createInFlightTransfers(deps: {
  cancelTransfer: (url: string) => void
}): InFlightTransfers {
  const entries = new Map<TrackId, Entry>()

  function start(trackId: TrackId, origin: DownloadOrigin): TransferHandle {
    const handle: TransferHandle = {
      trackId,
      origin: { current: origin },
      aborter: new AbortController(),
      setUrl: (url) => {
        const entry = entries.get(trackId)
        if (entry) entry.url = url
      },
      url: () => entries.get(trackId)?.url,
      release: () => {
        if (entries.get(trackId)?.handle === handle) entries.delete(trackId)
      },
    }
    entries.set(trackId, { handle, task: null, url: undefined })
    return handle
  }

  function cancel(trackId: TrackId): void {
    const entry = entries.get(trackId)
    if (!entry) return
    // Abort first and unconditionally: the attempt may not have reached the
    // native call yet, in which case this is the only thing that stops it.
    entry.handle.aborter.abort()
    if (!entry.url) return
    // Dropped so a later settle does not cancel the same transfer again.
    const url = entry.url
    entry.url = undefined
    deps.cancelTransfer(url)
  }

  function abortAll(): void {
    for (const entry of entries.values()) entry.handle.aborter.abort()
    for (const entry of entries.values()) {
      if (entry.url) deps.cancelTransfer(entry.url)
    }
    entries.clear()
  }

  return {
    has: (trackId) => entries.has(trackId),
    join: (trackId, origin) => {
      const entry = entries.get(trackId)
      if (!entry) return undefined
      if (origin === "user") entry.handle.origin.current = "user"
      return entry.task ?? undefined
    },
    running: (trackId) => entries.get(trackId)?.task ?? undefined,
    start,
    adopt: (handle, task) => {
      const entry = entries.get(handle.trackId)
      if (entry?.handle === handle) entry.task = task
    },
    cancel,
    abortAll,
  }
}
