import { AudioPlayer, type Status } from "@shruti/audio-player"
import type {
  AudioOpenParams,
  AudioProgressListener,
  IAudioPlayer,
} from "@ports/app/audioPlayer.js"

/**
 * Native adapter over the @shruti/audio-player Capacitor plugin.
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
          position: status.position,
          duration: status.duration,
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
      await AudioPlayer.seek({ position: positionMs })
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
