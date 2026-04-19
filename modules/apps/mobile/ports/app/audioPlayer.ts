/**
 * Port over a platform audio-playback engine.
 * Implemented by @infra/audio.capacitor (wrapping @shruti/audio-player)
 * and @infra/audio.web (wrapping HTMLAudioElement).
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

export interface IAudioPlayer {
  open(params: AudioOpenParams): Promise<void>
  play(): Promise<void>
  togglePause(): Promise<void>
  seek(positionMs: number): Promise<void>
  stop(): Promise<void>
  onProgress(listener: AudioProgressListener): () => void
}
