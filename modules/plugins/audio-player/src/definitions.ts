import type { Plugin } from '@capacitor/core'

/**
 * Open file request parameters for the audio player.
 */
export type OpenParams = {
  // The ID of the playlist item associated with this file
  itemId: string,

  // The URL of the audio track to play
  url: string,

  // The title of the audio track to be displayed
  // in the system player UI
  title: string,

  // The author of the audio track to be displayed
  // in the system player UI
  author: string,

  // Optional http(s)/content artwork URL shown as the system player /
  // lock-screen large icon. file:// URLs are ignored — native falls back
  // to a bundled branded image instead.
  cover?: string,
}

/**
 * Status of the audio player.
 * Contains information about the current playback state.
 */
export type Status = {
  itemId: string,
  playing: boolean,
  position: number,
  duration: number,
}

export interface AudioPlayerListenerResult {
  callbackId: string
}

/**
 * Stereo-mix configuration.
 *
 * Stereo recordings in our corpus may carry the original lecture in the
 * left channel and a translation in the right channel. Played as native
 * stereo this is uncomfortable in headphones — each ear hears different
 * content. `setMix` lets the UI blend both channels into a single mono
 * signal sent to both ears, with `ratio` controlling the bias between
 * left (original) and right (translation).
 *
 * When `enabled` is false the plugin must pass the original stereo
 * through unchanged, so users who want the raw bilingual experience
 * still get it.
 */
export type SetMixParams = {
  enabled: boolean
  /**
   * 0 — both ears hear the left channel (original) only.
   * 1 — both ears hear the right channel (translation) only.
   * 0.5 — balanced mono mix of both channels.
   *
   * Implementations apply loudness compensation so perceived volume
   * stays roughly constant across the range.
   */
  ratio: number
}

/**
 * Playback rate. `1.0` is normal speed; `2.0` is double-speed. The
 * implementations preserve pitch (no chipmunk effect) — `preservesPitch`
 * on web, `PlaybackParameters` with `pitch=1` on Android, and
 * `audioTimePitchAlgorithm = .timeDomain` on iOS.
 */
export type SetPlaybackRateParams = {
  rate: number
}

/**
 * Relative seek by the given delta in seconds (negative = back). The
 * implementations clamp to `[0, duration]` so callers can fire ±N
 * without worrying about the boundaries.
 */
export type SeekByParams = {
  delta: number
}

/**
 * How often the engine should push progress (`onProgressChanged`) to the
 * WebView while playing. This governs ONLY the JS bridge — the system
 * player / lock screen updates independently and interpolates position
 * between updates, so it stays smooth regardless of this value.
 *
 * The caller adapts it to context: ~500 ms when a transcript view needs
 * sub-second word highlighting, ~1000 ms when only the floating-player
 * progress ring is visible, and a slow heartbeat (e.g. 5000 ms) when the
 * app is backgrounded — where a 2 Hz stream would otherwise pile up in
 * the (throttled) WebView and flush as a janky burst on resume.
 */
export type SetProgressIntervalParams = {
  /** Emit interval in milliseconds. Clamped to a sane floor by the engine. */
  intervalMs: number
}

/**
 * One entry in the native playback queue. The whole point of the queue
 * is **background continuous playback**: native (ExoPlayer playlist /
 * AVQueuePlayer) advances through these items on its own when the app's
 * JS is suspended. So every item carries everything native needs to play
 * it and to label the lock screen without calling back into JS.
 *
 * Positions/durations are in **seconds** here, matching the rest of the
 * plugin surface (the app-side adapter converts to milliseconds).
 */
export type QueueItem = {
  // Playlist item id — the bookkeeping key echoed back in Status / events
  itemId: string
  // file:// (preferred) or HTTP url
  url: string
  title: string
  author: string
  // Optional http(s)/content artwork URL for the lock-screen large icon;
  // file:// is ignored in favour of a bundled branded image.
  cover?: string
  // Total duration in seconds, if known. Lets native report a completion
  // duration in transition events without probing the media.
  duration?: number
}

export type SetQueueParams = {
  items: QueueItem[]
  // Index within `items` to start playback from.
  startIndex: number
  // Resume position for the start item, in seconds. Auto-advanced items
  // always start at 0; only the start item honours this.
  startPosition: number
}

/**
 * A record of one item finishing and (maybe) the next starting. Native
 * appends one of these to a **durable on-disk journal** the instant it
 * happens — so the log survives the app being killed in the background
 * before JS ever wakes. JS drains the journal on next launch / resume.
 *
 * Only `reason: "auto"` (a natural end) means the item was completed; a
 * skip or an error finishes the item at `finishedAt` < `duration`.
 */
export type QueueTransition = {
  finishedItemId: string
  // Where listening on the finished item began (its resume point / 0), s.
  fromPosition: number
  // Position the finished item ended at, in seconds (~= duration on auto).
  finishedAt: number
  // Total duration of the finished item, in seconds.
  duration: number
  // The item that started playing next, or null when the queue ran dry.
  startedItemId: string | null
  reason: "auto" | "skip-next" | "skip-prev" | "error"
  // Native wall-clock when the transition happened (epoch ms). The
  // completion may be hours old by the time JS drains it.
  at: number
  // Monotonic per-install sequence — drives the idempotent ack-based clear.
  seq: number
}

/**
 * Snapshot of the native player + the drained transition journal. JS
 * reads this on launch/resume to (a) reconcile what played in the
 * background into `listening_sessions`, and (b) resync the now-playing
 * UI. Reading does NOT clear the journal — call `ackEvents` after the
 * events have been persisted so nothing is lost on a crash mid-drain.
 */
export type QueueState = {
  currentItemId: string | null
  // Current position / duration of the now-playing item, in seconds.
  position: number
  duration: number
  playing: boolean
  events: QueueTransition[]
}

export interface AudioPlayerPlugin extends Plugin {
  open(params: OpenParams): Promise<void>
  play(): Promise<void>
  togglePause(): Promise<void>
  seek(options: { position: number }): Promise<void>
  seekBy(options: SeekByParams): Promise<void>
  stop(): Promise<void>
  setMix(params: SetMixParams): Promise<void>
  setPlaybackRate(params: SetPlaybackRateParams): Promise<void>
  setProgressInterval(params: SetProgressIntervalParams): Promise<void>
  onProgressChanged(
    callback: (status: Status) => void
  ): Promise<AudioPlayerListenerResult>

  /**
   * Replace the playback queue and start at `startIndex` /
   * `startPosition`. A single track is just a queue of length 1, so this
   * is the one play path — `open()` is kept as a thin convenience wrapper
   * over a 1-item queue on the app side.
   */
  setQueue(params: SetQueueParams): Promise<void>
  /** Append items to the tail of the current queue (e.g. on resume when a
   *  download finished while backgrounded). */
  appendToQueue(params: { items: QueueItem[] }): Promise<void>
  /** Read the now-playing snapshot + the buffered transition journal.
   *  Does not clear the journal — see `ackEvents`. */
  getQueueState(): Promise<QueueState>
  /** Clear journal entries with `seq <= upToSeq` once JS has persisted
   *  them. Idempotent; survives multiple background→kill cycles. */
  ackEvents(options: { upToSeq: number }): Promise<void>
  /** Lock-screen / in-app skip to the next queue item. */
  skipToNext(): Promise<void>
  /** Lock-screen / in-app skip to the previous queue item. */
  skipToPrevious(): Promise<void>
  /** Best-effort foreground push on each transition — pure UI sugar; the
   *  durable journal drained via `getQueueState` is the source of truth. */
  onItemTransition(
    callback: (transition: QueueTransition) => void
  ): Promise<AudioPlayerListenerResult>
}