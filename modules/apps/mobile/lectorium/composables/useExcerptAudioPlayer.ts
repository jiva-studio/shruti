import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from "vue"
import { useAudioSource } from "@lectorium/composables/useAudioOrchestrator.js"

/**
 * Shared audio-lifecycle for the inline excerpt players (the notes
 * inline player and the chat focus player). They render different chrome
 * (button size / colour, waveform peaks: decoded vs placeholder) but the
 * playback machinery is identical: a hidden `<audio>` element, the
 * play/pause/seek state, the orchestrator `claim` that pauses every other
 * inline player, the prepare-then-play `onToggle` flow, and the five DOM
 * event handlers.
 *
 * The component binds `ref="audioEl"` and the `@play/@pause/@ended/
 * @timeupdate/@loadedmetadata` handlers to this composable, supplies its
 * own URL resolution (`resolveUrl` / `cachedUrl`) + a `hasSource` guard,
 * and renders `progressFraction` over its peaks.
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
} {
  const audioEl = ref<HTMLAudioElement | null>(null)
  const isPlaying = ref(false)
  const isPreparing = ref(false)
  const positionMs = ref(0)
  const durationMs = ref(0)

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
    const known = opts.cachedUrl()
    if (!known) {
      isPreparing.value = true
      try {
        el.src = await opts.resolveUrl()
      } catch (err) {
        isPreparing.value = false
        console.warn(`[${opts.logLabel}] cut failed:`, err)
        return
      }
      isPreparing.value = false
    } else if (!el.src) {
      el.src = known
    }
    claim()
    try {
      await el.play()
    } catch (err) {
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

  function onPlay(): void {
    isPlaying.value = true
  }

  function onPause(): void {
    isPlaying.value = false
  }

  function onEnded(): void {
    isPlaying.value = false
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
  }
}
