import { onBeforeUnmount, ref, type Ref } from 'vue'

export function useLectureAudioPlayer(opts: { initialDurationMs?: number } = {}): {
  audioEl: Ref<HTMLAudioElement | null>
  playing: Ref<boolean>
  busy: Ref<boolean>
  positionMs: Ref<number>
  durationMs: Ref<number>
  speed: Ref<number>
  onTimeUpdate: () => void
  onLoadedMetadata: () => void
  onPlay: () => void
  onPause: () => void
  onEnded: () => void
  onWaiting: () => void
  onPlaying: () => void
  toggle: () => void
  skipBack: () => void
  skipForward: () => void
  seek: (ms: number) => void
  setSpeed: (value: number) => void
} {
  const audioEl = ref<HTMLAudioElement | null>(null)
  const playing = ref(false)
  const busy = ref(false)
  const positionMs = ref(0)
  const durationMs = ref(opts.initialDurationMs ?? 0)
  const speed = ref(1)

  function onTimeUpdate() {
    if (audioEl.value) positionMs.value = audioEl.value.currentTime * 1000
  }
  function onLoadedMetadata() {
    if (audioEl.value && Number.isFinite(audioEl.value.duration)) {
      durationMs.value = audioEl.value.duration * 1000
    }
  }
  function onPlay() {
    playing.value = true
  }
  function onPause() {
    playing.value = false
  }
  function onEnded() {
    playing.value = false
  }
  function onWaiting() {
    busy.value = true
  }
  function onPlaying() {
    busy.value = false
  }

  function ensurePlaying() {
    const el = audioEl.value
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
  }

  function toggle() {
    const el = audioEl.value
    if (!el) return
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }

  function skipBack() {
    const el = audioEl.value
    if (!el) return
    el.currentTime = Math.max(0, el.currentTime - 15)
  }

  function skipForward() {
    const el = audioEl.value
    if (!el) return
    const max = Number.isFinite(el.duration) ? el.duration : el.currentTime + 15
    el.currentTime = Math.min(max, el.currentTime + 15)
  }

  function seek(ms: number) {
    const el = audioEl.value
    if (!el) return
    el.currentTime = ms / 1000
    positionMs.value = ms
    ensurePlaying()
  }

  function setSpeed(value: number) {
    speed.value = value
    if (audioEl.value) audioEl.value.playbackRate = value
  }

  onBeforeUnmount(() => {
    if (audioEl.value && !audioEl.value.paused) audioEl.value.pause()
  })

  return {
    audioEl,
    playing,
    busy,
    positionMs,
    durationMs,
    speed,
    onTimeUpdate,
    onLoadedMetadata,
    onPlay,
    onPause,
    onEnded,
    onWaiting,
    onPlaying,
    toggle,
    skipBack,
    skipForward,
    seek,
    setSpeed,
  }
}
