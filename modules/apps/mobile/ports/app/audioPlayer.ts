/**
 * Port over a platform audio-playback engine.
 * Implemented by @infra/audio/capacitor (wrapping @lectorium/plugin-audio-player)
 * and @infra/audio/web (wrapping HTMLAudioElement).
 */
export interface AudioOpenParams {
  itemId: string
  url: string
  title: string
  author: string
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
  onProgress(listener: AudioProgressListener): () => void
}
