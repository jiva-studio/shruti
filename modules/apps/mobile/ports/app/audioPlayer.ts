/**
 * Port over a platform audio-playback engine.
 * Implemented by @infra/audio/capacitor (a single cross-platform adapter
 * wrapping @lectorium/plugin-audio-player; the plugin itself handles the
 * web fallback via HTMLAudioElement).
 */
export interface AudioOpenParams {
  itemId: string
  url: string
  title: string
  author: string
  /** Optional http(s) artwork URL for the lock-screen large icon. */
  cover?: string
}

export interface AudioStatus {
  itemId: string
  playing: boolean
  /** Current position in milliseconds. */
  position: number
  /** Total duration in milliseconds. */
  duration: number
}

export type AudioProgressListener = (status: AudioStatus) => void

/**
 * Stereo-mix configuration. Stereo recordings in our corpus may carry
 * the original lecture in the left channel and a translation in the
 * right channel. `setMix` lets the UI fold both channels into a mono
 * signal sent to both ears, with `ratio` controlling the bias between
 * left (0 — only original) and right (1 — only translation).
 *
 * When `enabled` is false the engine plays the source as native stereo
 * (different content per ear) — kept as an explicit option for users
 * who want the raw bilingual experience.
 */
export interface AudioMixParams {
  enabled: boolean
  /** 0 = full left, 1 = full right, 0.5 = balanced. */
  ratio: number
}

/**
 * One entry in the native playback queue (milliseconds, like the rest of
 * this port). See the plugin's `QueueItem` for the background-playback
 * rationale.
 */
export interface AudioQueueItem {
  itemId: string
  url: string
  title: string
  author: string
  /** Optional http(s) artwork URL for the lock-screen large icon. */
  cover?: string
  /** Total duration in milliseconds, if known. */
  durationMs?: number
}

/**
 * One finished-item record from the native durable journal (milliseconds).
 * Only `reason: "auto"` means the item was completed.
 */
export interface AudioQueueTransition {
  finishedItemId: string
  fromPositionMs: number
  finishedAtMs: number
  durationMs: number
  startedItemId: string | null
  reason: "auto" | "skip-next" | "skip-prev" | "error"
  /** Native wall-clock of the transition (epoch ms). */
  at: number
  /**
   * Native wall-clock when listening on this item began (epoch ms) — the
   * `fromPositionMs` counterpart, making `[fromAt, at]` the run's exact span.
   * Undefined for an entry an older build left in the durable journal, which
   * the caller then has to estimate.
   */
  fromAt?: number
  /** Monotonic sequence; pass back to `ackEvents` to clear. */
  seq: number
}

/** Now-playing snapshot + drained transition journal (milliseconds). */
export interface AudioQueueState {
  currentItemId: string | null
  positionMs: number
  durationMs: number
  playing: boolean
  events: AudioQueueTransition[]
}

export type AudioTransitionListener = (transition: AudioQueueTransition) => void

/**
 * A position jump the engine performed on its own — lock-screen scrubbing,
 * the system ±15 s / seek commands, a Bluetooth remote. Seeks JS asked for are
 * NOT reported here; the caller already journals those, and a second report
 * would open a spurious session.
 */
export interface AudioPositionJump {
  itemId: string
  fromMs: number
  toMs: number
}

export type AudioPositionJumpListener = (jump: AudioPositionJump) => void

export interface IAudioPlayer {
  open(params: AudioOpenParams): Promise<void>
  play(): Promise<void>
  togglePause(): Promise<void>
  seek(positionMs: number): Promise<void>
  /** Relative seek by delta milliseconds (negative = back). Engines clamp to [0, duration]. */
  seekBy(deltaMs: number): Promise<void>
  stop(): Promise<void>
  setMix(params: AudioMixParams): Promise<void>
  /** Set playback rate (1.0 = normal). Engines preserve pitch. */
  setPlaybackRate(rate: number): Promise<void>
  /**
   * Set how often the engine pushes progress to the WebView while playing,
   * in milliseconds. Governs only the JS bridge — the system player / lock
   * screen interpolates position independently and stays smooth. Callers
   * adapt it to context (fast for transcript highlighting, slow/heartbeat
   * when backgrounded) to avoid a backlog of events building up while the
   * WebView is throttled.
   */
  setProgressInterval(intervalMs: number): Promise<void>
  onProgress(listener: AudioProgressListener): () => void
  /** Engine-initiated position jumps, so the caller can journal the
   *  discontinuity instead of absorbing it as listened audio. */
  onPositionJump(listener: AudioPositionJumpListener): () => void

  /** Replace the queue and start at `startIndex` / `startPositionMs`. */
  setQueue(items: AudioQueueItem[], startIndex: number, startPositionMs: number): Promise<void>
  /** Append items to the tail of the current queue. */
  appendToQueue(items: AudioQueueItem[]): Promise<void>
  /** Read the now-playing snapshot + buffered transition journal. Does not clear it. */
  getQueueState(): Promise<AudioQueueState>
  /** Clear journal entries with `seq <= upToSeq`. */
  ackEvents(upToSeq: number): Promise<void>
  skipToNext(): Promise<void>
  skipToPrevious(): Promise<void>
  /** Foreground-only push on each transition (UI sugar; journal is source of truth). */
  onTransition(listener: AudioTransitionListener): () => void
}
