import { ref, type Ref } from 'vue'
import { useAudioSource } from '@lib/chat/audio/useAudioOrchestrator.js'

export function useMediaControls(): {
  mediaEl: Ref<HTMLVideoElement | HTMLAudioElement | null>
  playing: Ref<boolean>
  progress: Ref<number>
  buffered: Ref<number>
  onTimeUpdate: () => void
  onProgress: () => void
  onSeek: (ratio: number) => void
  toggle: () => Promise<void>
} {
  const mediaEl = ref<HTMLVideoElement | HTMLAudioElement | null>(null)
  const playing = ref(false)
  const progress = ref(0)
  const buffered = ref(0)

  function onTimeUpdate(): void {
    const el = mediaEl.value
    progress.value = el && el.duration > 0 ? el.currentTime / el.duration : 0
    onProgress()
  }

  function onProgress(): void {
    const el = mediaEl.value
    if (!el || el.duration <= 0 || el.buffered.length === 0) {
      buffered.value = 0
      return
    }
    let end = 0
    for (let i = 0; i < el.buffered.length; i++) {
      if (el.buffered.start(i) <= el.currentTime && el.currentTime <= el.buffered.end(i)) {
        end = el.buffered.end(i)
        break
      }
      end = Math.max(end, el.buffered.end(i))
    }
    buffered.value = end / el.duration
  }

  function onSeek(ratio: number): void {
    const el = mediaEl.value
    if (!el || !el.duration) return
    el.currentTime = el.duration * Math.min(1, Math.max(0, ratio))
  }

  const { claim } = useAudioSource('inline', () => mediaEl.value?.pause())

  async function toggle(): Promise<void> {
    const el = mediaEl.value
    if (!el) return
    if (!el.paused) {
      el.pause()
      return
    }
    claim()
    try {
      await el.play()
    } catch {
      // autoplay/buffer hiccup — user can tap again
    }
  }

  return { mediaEl, playing, progress, buffered, onTimeUpdate, onProgress, onSeek, toggle }
}
