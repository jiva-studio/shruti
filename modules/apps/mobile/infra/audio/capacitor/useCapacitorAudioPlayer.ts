import { AudioPlayer, type Status } from "@lectorium/audio-player"
import type {
  AudioOpenParams,
  AudioProgressListener,
  IAudioPlayer,
} from "@ports/app/audioPlayer.js"

/**
 * Adapter over the @lectorium/audio-player Capacitor plugin (native +
 * web fallback).
 *
 * The plugin's surface (Android/iOS/web fallback) speaks **seconds** for
 * positions and durations — same convention as HTMLMediaElement. Our
 * `IAudioPlayer` contract speaks **milliseconds**. This adapter is the
 * single boundary where the conversion happens, so the rest of the app
 * stays in one consistent unit.
 *
 * onProgressChanged in the plugin is a fire-and-forget subscription —
 * there is no off() on the returned id, so we multiplex listeners in
 * this adapter and register the plugin callback only once.
 */
export function useCapacitorAudioPlayer(): IAudioPlayer {
  const listeners = new Set<AudioProgressListener>()
  let registered = false

  async function ensureRegistered(): Promise<void> {
    if (registered) return
    registered = true
    await AudioPlayer.onProgressChanged((status: Status) => {
      for (const fn of listeners) {
        fn({
          itemId: status.itemId,
          playing: status.playing,
          position: Math.round(status.position * 1000),
          duration: Math.round(status.duration * 1000),
        })
      }
    })
  }

  return {
    async open(params: AudioOpenParams): Promise<void> {
      await ensureRegistered()
      await AudioPlayer.open({
        itemId: params.itemId,
        url: params.url,
        title: params.title,
        author: params.author,
      })
    },
    async play(): Promise<void> {
      await AudioPlayer.play()
    },
    async togglePause(): Promise<void> {
      await AudioPlayer.togglePause()
    },
    async seek(positionMs: number): Promise<void> {
      await AudioPlayer.seek({ position: positionMs / 1000 })
    },
    async stop(): Promise<void> {
      await AudioPlayer.stop()
    },
    onProgress(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
