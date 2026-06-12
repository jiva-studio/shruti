import { onBeforeUnmount, ref, type Ref, type ShallowRef } from "vue"
import { useAudioSource } from "@lectorium/composables/useAudioOrchestrator.js"

const PLAY_TIMEOUT_MS = 15000

/**
 * Audio-playback engine for a citation chip's excerpt: registers with the
 * one-at-a-time audio orchestrator, drives the play/pause + spinner state,
 * tracks progress, and watchdogs a wedged buffer. Extracted from
 * CitationChip.vue so the component keeps presentation, metadata, the long-
 * press gesture, and the action sheet.
 *
 * The element's `src` is set lazily on first play. `resolveUrl` returns the
 * (cached or freshly-cut) excerpt URL, or null when resolution failed — the
 * caller owns surfacing that to the user (toast); this engine only drives the
 * `<audio>` element. The handler functions map 1:1 to the element's media
 * events; bind them in the template.
 */
export function useCitationAudio(opts: {
  audioEl: Readonly<ShallowRef<HTMLAudioElement | null>>
  resolveUrl: () => Promise<string | null>
}): {
  isPlaying: Ref<boolean>
  isPreparing: Ref<boolean>
  progressPct: Ref<number>
  toggle: () => Promise<void>
  onPlay: () => void
  onPlaying: () => void
  onCanPlay: () => void
  onWaiting: () => void
  onError: () => void
  onPause: () => void
  onEnded: () => void
  onTimeUpdate: () => void
} {
  const { audioEl, resolveUrl } = opts
  const isPlaying = ref(false)
  const isPreparing = ref(false)
  const progressPct = ref(0)

  // After a long resolve the element can resolve `play()` (and fire `play`)
  // while still buffering/stalled — silent pause icon. We hold the spinner
  // until real playback (`playing`/`canplay`) and arm a watchdog so a wedged
  // buffer resets cleanly instead of stranding the user.
  let playTimer: ReturnType<typeof setTimeout> | null = null
  function clearPlayTimer(): void {
    if (playTimer) {
      clearTimeout(playTimer)
      playTimer = null
    }
  }

  function pauseSelf(): void {
    const el = audioEl.value
    if (!el) return
    clearPlayTimer()
    isPreparing.value = false
    el.pause()
  }

  // Register as an "inline" audio source. `claim()` (in onPlay) pauses every
  // other source — sibling chips, the focus card, AND the main lecture
  // player; `pauseSelf` runs whenever any of them claims.
  const { claim } = useAudioSource("inline", pauseSelf)

  async function toggle(): Promise<void> {
    const el = audioEl.value
    if (!el) return
    if (isPlaying.value) {
      el.pause()
      return
    }
    isPreparing.value = true
    if (!el.src) {
      const url = await resolveUrl()
      if (!url) {
        isPreparing.value = false
        return
      }
      el.src = url
    }
    // Keep the spinner up across play() — cleared by `playing`/`canplay`,
    // not the resolved promise — and watchdog a stalled buffer.
    clearPlayTimer()
    playTimer = setTimeout(() => {
      playTimer = null
      if (!isPlaying.value) {
        isPreparing.value = false
        el.pause()
        console.warn("[citation-chip] playback did not start in time")
      }
    }, PLAY_TIMEOUT_MS)
    try {
      await el.play()
    } catch (err) {
      clearPlayTimer()
      isPreparing.value = false
      console.warn("[citation-chip] play failed", err)
    }
  }

  function onPlay(): void {
    clearPlayTimer()
    isPlaying.value = true
    isPreparing.value = false
    claim()
  }

  function onPlaying(): void {
    clearPlayTimer()
    isPlaying.value = true
    isPreparing.value = false
  }

  function onCanPlay(): void {
    if (isPlaying.value) isPreparing.value = false
  }

  function onWaiting(): void {
    isPreparing.value = true
  }

  function onError(): void {
    clearPlayTimer()
    isPlaying.value = false
    isPreparing.value = false
    console.warn("[citation-chip] audio element error")
  }

  function onPause(): void {
    isPlaying.value = false
  }

  function onEnded(): void {
    clearPlayTimer()
    isPlaying.value = false
    isPreparing.value = false
    const el = audioEl.value
    if (el) el.currentTime = 0
    progressPct.value = 0
  }

  function onTimeUpdate(): void {
    const el = audioEl.value
    if (!el) return
    const dur = el.duration
    if (!Number.isFinite(dur) || dur <= 0) return
    progressPct.value = Math.min(100, Math.max(0, (el.currentTime / dur) * 100))
  }

  onBeforeUnmount(() => {
    clearPlayTimer()
    audioEl.value?.pause()
  })

  return {
    isPlaying,
    isPreparing,
    progressPct,
    toggle,
    onPlay,
    onPlaying,
    onCanPlay,
    onWaiting,
    onError,
    onPause,
    onEnded,
    onTimeUpdate,
  }
}
