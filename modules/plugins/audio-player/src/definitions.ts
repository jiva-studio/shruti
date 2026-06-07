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
}