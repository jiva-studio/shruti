import { AudioPlayer, type Status } from "@lectorium/plugin-audio-player"
import type {
  AudioMixParams,
  AudioOpenParams,
  AudioProgressListener,
  IAudioPlayer,
} from "@ports/app/audioPlayer.js"

/**
 * Adapter over the @lectorium/plugin-audio-player Capacitor plugin (native +
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
    async seekBy(deltaMs: number): Promise<void> {
      const safe = Number.isFinite(deltaMs) ? deltaMs : 0
      // Plugin surface speaks seconds (same as `seek`). The IAudioPlayer
      // contract is in milliseconds; this is the boundary that converts.
      await AudioPlayer.seekBy({ delta: safe / 1000 })
    },
    async setMix(params: AudioMixParams): Promise<void> {
      const ratio = clamp01(params.ratio)
      await AudioPlayer.setMix({ enabled: params.enabled, ratio })
    },
    async setPlaybackRate(rate: number): Promise<void> {
      let safe = Number.isFinite(rate) ? rate : 1
      if (safe < 0.5) safe = 0.5
      if (safe > 2) safe = 2
      await AudioPlayer.setPlaybackRate({ rate: safe })
    },
    async setProgressInterval(intervalMs: number): Promise<void> {
      const safe = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.round(intervalMs) : 1000
      await AudioPlayer.setProgressInterval({ intervalMs: safe })
    },
    onProgress(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
