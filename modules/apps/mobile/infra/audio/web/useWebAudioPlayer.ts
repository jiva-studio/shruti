import type {
  AudioOpenParams,
  AudioProgressListener,
  IAudioPlayer,
} from "@ports/app/audioPlayer.js"

/**
 * HTMLAudioElement adapter for the browser.
 *
 * Timeupdate fires ~4x/sec which is enough for the floating player and
 * transcript highlight. We synthesize an AudioStatus on each event and
 * fan it out to every listener registered by the store.
 */
export function useWebAudioPlayer(): IAudioPlayer {
  const audio = new Audio()
  audio.preload = "metadata"

  let currentItemId: string | null = null
  const listeners = new Set<AudioProgressListener>()

  function emit(): void {
    if (!currentItemId) return
    const durationMs = Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : 0
    const positionMs = Number.isFinite(audio.currentTime) ? Math.round(audio.currentTime * 1000) : 0
    for (const fn of listeners) {
      fn({
        itemId: currentItemId,
        playing: !audio.paused,
        position: positionMs,
        duration: durationMs,
      })
    }
  }

  audio.addEventListener("timeupdate", emit)
  audio.addEventListener("play", emit)
  audio.addEventListener("pause", emit)
  audio.addEventListener("ended", emit)
  audio.addEventListener("loadedmetadata", emit)

  return {
    async open(params: AudioOpenParams): Promise<void> {
      currentItemId = params.itemId
      audio.src = params.url
      audio.load()
    },
    async play(): Promise<void> {
      await audio.play()
    },
    async togglePause(): Promise<void> {
      if (audio.paused) await audio.play()
      else audio.pause()
    },
    async seek(positionMs: number): Promise<void> {
      audio.currentTime = positionMs / 1000
    },
    async stop(): Promise<void> {
      audio.pause()
      audio.currentTime = 0
    },
    onProgress(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
