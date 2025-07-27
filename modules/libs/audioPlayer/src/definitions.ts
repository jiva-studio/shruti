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

export interface AudioPlayerPlugin extends Plugin {
  open(params: OpenParams): Promise<void>
  play(): Promise<void>
  togglePause(): Promise<void>
  seek(options: { position: number }): Promise<void>
  stop(): Promise<void>
  onProgressChanged(
    callback: (status: Status) => void
  ): Promise<AudioPlayerListenerResult>
}