import type { LanguageCode, PlaylistItemId, TrackId } from "@lib/domain/core.js"

/**
 * The native playback queue as the playback use cases drive it. The shapes
 * mirror the audio-player port, which this layer cannot import.
 */

/** One entry on the engine's timeline. */
export interface PlaybackQueueItem {
  itemId: string
  url: string
  title: string
  author: string
  cover?: string
  durationMs?: number
}

/** One finished-item record from the engine's durable journal (milliseconds). */
export interface PlaybackQueueTransition {
  finishedItemId: string
  fromPositionMs: number
  finishedAtMs: number
  durationMs: number
  startedItemId: string | null
  reason: "auto" | "skip-next" | "skip-prev" | "error"
  /** Engine wall-clock of the transition (epoch ms). */
  at: number
  /** Engine wall-clock when listening on this item began (epoch ms); absent
   *  for an entry an older build left in the journal. */
  fromAt?: number
  /** Monotonic sequence; acked to clear. */
  seq: number
}

/** What the engine is on right now. */
export interface PlaybackQueueSnapshot {
  currentItemId: string | null
  positionMs: number
  playing: boolean
}

/** The part of the audio engine the queue use cases drive. */
export interface PlaybackQueueEngine {
  getQueueState(): Promise<PlaybackQueueSnapshot>
  /** A full replace: the plugin has no per-item removal. */
  setQueue(items: PlaybackQueueItem[], startIndex: number, startPositionMs: number): Promise<void>
  ackEvents(upToSeq: number): Promise<void>
}

/** What the player's queue mirror reads and drives. */
export interface PlayerQueueMirrorDeps {
  /** What the player shows as playing, read live. */
  readonly identity: {
    itemId(): PlaylistItemId | null
    positionMs(): number
    /** Moves only on a progress tick, so it lags a pause tap by up to a second. */
    playing(): boolean
    language(): LanguageCode | null
  }
  /** The continuous-playback setting; also gates a late entitlement re-arm. */
  readonly autoPlayNext: () => boolean
  readonly engine: Pick<PlaybackQueueEngine, "getQueueState" | "setQueue">
  /** Read per call. */
  readonly playlist: () => {
    buildQueueFrom(
      fromItemId: PlaylistItemId,
      preferredLanguage?: LanguageCode
    ): Promise<PlaybackQueueItem[]>
    resolveTrackForItemId(itemId: PlaylistItemId): Promise<{ readonly id: TrackId } | undefined>
  }
  /** Read per call. */
  readonly downloads: () => {
    markEvictPending(trackId: TrackId): Promise<void>
    evict(trackId: TrackId): Promise<boolean>
  }
  readonly reportError: (err: unknown) => void
}

/** A rejection handler that hands the error to `report` and answers `fallback`. */
export function reportAndReturn<T>(report: (err: unknown) => void, fallback: T) {
  return (err: unknown): T => {
    report(err)
    return fallback
  }
}
