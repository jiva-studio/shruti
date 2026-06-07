import { onBeforeUnmount, onMounted, ref, type Ref } from "vue"

/* -------------------------------------------------------------------------- */
/*                                 Resolution                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolution at which real audio is decoded into peaks. Kept high and
 * fixed (independent of how many bars are actually drawn) so the same
 * decoded buffer can be down-sampled to whatever bar count the current
 * screen width calls for — see {@link resamplePeaks}. Also caps the
 * displayed bar count so we never up-sample.
 */
export const WAVEFORM_RAW_PEAKS = 400

/** Drawn bar width + the gap we aim to leave between bars, in px. The
 *  displayed bar count is the container width divided by this pitch, so
 *  the spacing stays constant instead of stretching on wide screens. */
const BAR_WIDTH_PX = 2
const BAR_GAP_PX = 2
const BAR_PITCH_PX = BAR_WIDTH_PX + BAR_GAP_PX

const MIN_BARS = 24
const MAX_BARS = WAVEFORM_RAW_PEAKS
/** Sensible count to render for the first frame, before the container
 *  has been measured (corrected synchronously in onMounted). */
const DEFAULT_BARS = 64

/* -------------------------------------------------------------------------- */
/*                              Placeholder peaks                              */
/* -------------------------------------------------------------------------- */

function hashStringTo32(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Placeholder peaks used until the real audio buffer has been decoded.
 * Seeded by `seed` so every row keeps a recognisable shape even before
 * its excerpt has been generated. Built directly at the requested
 * `count` so the placeholder fills the container at any width.
 */
export function buildPlaceholderPeaks(seed: string, count: number): number[] {
  const rand = mulberry32(hashStringTo32(seed) || 1)
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const r = rand()
    let h: number
    if (r < 0.1) h = 4 + rand() * 12
    else if (r > 0.875) h = 80 + rand() * 18
    else h = 25 + rand() * 50
    out.push(Math.round(h))
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*                                 Resampling                                  */
/* -------------------------------------------------------------------------- */

/**
 * Down-sample a high-resolution peaks array to `count` bars, taking the
 * max within each bucket so loud transients survive the reduction. With
 * `count <= raw.length` (guaranteed by the bar-count clamp) this is a
 * pure down-sample; it degrades gracefully (repeats samples) otherwise.
 */
export function resamplePeaks(raw: number[], count: number): number[] {
  if (count <= 0 || raw.length === 0) return []
  if (count >= raw.length) return raw.slice()
  const out: number[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * raw.length) / count)
    const end = Math.max(start + 1, Math.floor(((i + 1) * raw.length) / count))
    let peak = 0
    for (let j = start; j < end && j < raw.length; j++) {
      if (raw[j] > peak) peak = raw[j]
    }
    out[i] = peak
  }
  return out
}

/* -------------------------------------------------------------------------- */
/*                          Responsive bar count                              */
/* -------------------------------------------------------------------------- */

/**
 * Reactive number of waveform bars to draw, derived from the live width
 * of `el` so the spacing stays constant across screen sizes (a fixed
 * count would spread out into sparse ticks on a wide layout). Tracks
 * resizes via ResizeObserver and clamps to a sane range.
 */
export function useResponsiveBarCount(
  el: Ref<HTMLElement | null | undefined>,
  pitchPx: number = BAR_PITCH_PX
): Ref<number> {
  const count = ref(DEFAULT_BARS)
  let observer: ResizeObserver | null = null

  function measure(): void {
    const width = el.value?.clientWidth ?? 0
    if (width <= 0) return
    const n = Math.round(width / pitchPx)
    count.value = Math.max(MIN_BARS, Math.min(MAX_BARS, n))
  }

  onMounted(() => {
    if (typeof ResizeObserver === "undefined") {
      measure()
      return
    }
    observer = new ResizeObserver(() => measure())
    if (el.value) observer.observe(el.value)
    measure()
  })

  onBeforeUnmount(() => observer?.disconnect())

  return count
}
