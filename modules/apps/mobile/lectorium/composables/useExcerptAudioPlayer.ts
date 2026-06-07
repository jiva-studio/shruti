import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from "vue"
import { useAudioSource } from "@lectorium/composables/useAudioOrchestrator.js"

/** How long to wait after `play()` for real playback before giving up and
 * resetting state so a retry tap starts clean (covers a wedged buffer /
 * silently-stalled element that never fires `playing`). */
const PLAY_TIMEOUT_MS = 15000

/**
 * Shared audio-lifecycle for the inline excerpt players (the notes
 * inline player and the chat focus player). They render different chrome
 * (button size / colour, waveform peaks: decoded vs placeholder) but the
 * playback machinery is identical: a hidden `<audio>` element, the
 * play/pause/seek state, the orchestrator `claim` that pauses every other
 * inline player, the prepare-then-play `onToggle` flow, and the DOM
 * event handlers.
 *
 * The component binds `ref="audioEl"` and the `@play/@pause/@ended/
 * @timeupdate/@loadedmetadata/@waiting/@stalled/@playing/@canplay/@error`
 * handlers to this composable, supplies its own URL resolution
 * (`resolveUrl` / `cachedUrl`) + a `hasSource` guard, and renders
 * `progressFraction` over its peaks.
 *
 * `isPlaying` is driven by an actual `playing`/`canplay` signal rather
 * than the resolved `play()` promise: with `preload="none"` (and a cold
 * download / long cut behind `resolveUrl`) the promise can resolve while
 * the element is still buffering, which would show a pause icon over
 * silence. `isPreparing` covers that buffer window so the spinner stays
 * up until sound actually starts.
 */
export function useExcerptAudioPlayer(opts: {
  /** False keeps the play button inert (no source key yet). */
  hasSource: () => boolean
  /** Already-resolved excerpt URL, or null if not cut yet. */
  cachedUrl: () => string | null
  /** Cut (or fetch the cached) excerpt URL. May throw on failure. */
  resolveUrl: () => Promise<string>
  /** Prefix for the dev-console warnings. */
  logLabel: string
}): {
  audioEl: Ref<HTMLAudioElement | null>
  isPlaying: Ref<boolean>
  isPreparing: Ref<boolean>
  progressFraction: ComputedRef<number>
  onToggle: () => Promise<void>
  onWaveformClick: (event: MouseEvent) => void
  onPlay: () => void
  onPause: () => void
  onEnded: () => void
  onTimeUpdate: () => void
  onMetadata: () => void
  onWaiting: () => void
  onPlaying: () => void
  onCanPlay: () => void
  onError: () => void
} {
  const audioEl = ref<HTMLAudioElement | null>(null)
  const isPlaying = ref(false)
  const isPreparing = ref(false)
  const positionMs = ref(0)
  const durationMs = ref(0)
  let playTimeout: ReturnType<typeof setTimeout> | null = null

  function clearPlayTimeout(): void {
    if (playTimeout) {
      clearTimeout(playTimeout)
      playTimeout = null
    }
  }

  const progressFraction = computed(() => {
    if (durationMs.value <= 0) return 0
    return Math.min(1, Math.max(0, positionMs.value / durationMs.value))
  })

  /**
   * Pause this player AND rewind it to the start. When another inline
   * player (or the main lecture, via App.vue) signals it's about to play,
   * the others reset to their initial state rather than sitting paused
   * mid-clip in scattered positions.
   */
  function pauseAndResetSelf(): void {
    const el = audioEl.value
    if (!el) return
    clearPlayTimeout()
    isPreparing.value = false
    el.pause()
    el.currentTime = 0
    positionMs.value = 0
  }

  const { claim } = useAudioSource("inline", pauseAndResetSelf)

  async function onToggle(): Promise<void> {
    const el = audioEl.value
    if (!el) return
    if (isPlaying.value) {
      el.pause()
      return
    }
    if (!opts.hasSource()) {
      console.warn(`[${opts.logLabel}] missing source audio`)
      return
    }
    isPreparing.value = true
    const known = opts.cachedUrl()
    if (!known) {
      try {
        el.src = await opts.resolveUrl()
      } catch (err) {
        isPreparing.value = false
        console.warn(`[${opts.logLabel}] cut failed:`, err)
        return
      }
    } else if (!el.src) {
      el.src = known
    }
    claim()
    // Arm a timeout: if real playback (`playing`) hasn't cleared the
    // loading flag within the window, reset so the pause icon never shows
    // over silence and a retry tap starts from scratch.
    clearPlayTimeout()
    playTimeout = setTimeout(() => {
      playTimeout = null
      if (!isPlaying.value) {
        isPreparing.value = false
        el.pause()
        console.warn(`[${opts.logLabel}] playback did not start in time`)
      }
    }, PLAY_TIMEOUT_MS)
    try {
      await el.play()
    } catch (err) {
      clearPlayTimeout()
      isPreparing.value = false
      console.warn(`[${opts.logLabel}] play failed:`, err)
    }
  }

  function onWaveformClick(event: MouseEvent): void {
    const el = audioEl.value
    if (!el || durationMs.value <= 0) return
    const target = event.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    el.currentTime = (durationMs.value / 1000) * ratio
  }

  /**
   * `play` (and `playing`/`canplay`): the element actually started
   * producing sound, so clear the loading flag and the watchdog. We hold
   * the spinner until one of these fires rather than the resolved
   * `play()` promise, so the pause icon never appears while silent.
   */
  function onPlay(): void {
    clearPlayTimeout()
    isPlaying.value = true
    isPreparing.value = false
  }

  function onPlaying(): void {
    clearPlayTimeout()
    isPlaying.value = true
    isPreparing.value = false
  }

  function onCanPlay(): void {
    // Buffer caught up after a `waiting`/`stalled`. Only clear the
    // spinner; don't assert playback if the user already paused.
    if (isPlaying.value) isPreparing.value = false
  }

  /** `waiting`/`stalled` — buffer underrun mid-play. Re-show the spinner. */
  function onWaiting(): void {
    isPreparing.value = true
  }

  function onPause(): void {
    isPlaying.value = false
  }

  function onError(): void {
    clearPlayTimeout()
    isPlaying.value = false
    isPreparing.value = false
    console.warn(`[${opts.logLabel}] audio element error`)
  }

  function onEnded(): void {
    clearPlayTimeout()
    isPlaying.value = false
    isPreparing.value = false
    positionMs.value = 0
    const el = audioEl.value
    if (el) el.currentTime = 0
  }

  function onTimeUpdate(): void {
    const el = audioEl.value
    if (!el) return
    positionMs.value = el.currentTime * 1000
  }

  function onMetadata(): void {
    const el = audioEl.value
    if (!el) return
    durationMs.value = (el.duration || 0) * 1000
  }

  onBeforeUnmount(() => {
    clearPlayTimeout()
    audioEl.value?.pause()
  })

  return {
    audioEl,
    isPlaying,
    isPreparing,
    progressFraction,
    onToggle,
    onWaveformClick,
    onPlay,
    onPause,
    onEnded,
    onTimeUpdate,
    onMetadata,
    onWaiting,
    onPlaying,
    onCanPlay,
    onError,
  }
}
