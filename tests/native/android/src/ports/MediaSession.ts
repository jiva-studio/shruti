export enum PlaybackState {
  Paused = 2,
  Playing = 3,
}

/** The playback state the OS sees — the same one the notification shade renders. */
export interface MediaSession {
  state(): Promise<PlaybackState | null>
  positionMs(): Promise<number | null>
  hasShadeNotification(): Promise<boolean>
  dispatch(action: "play" | "pause" | "play-pause"): Promise<void>
  waitUntilState(state: PlaybackState, timeoutMs?: number): Promise<void>
  waitUntilPlaying(timeoutMs?: number): Promise<void>
}
