import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { SHORT_POLL_TIMEOUT_MS, pollUntilReady } from "@shruti/services/pollUntilReady.js"
import {
  WAVEFORM_RAW_PEAKS,
  buildPlaceholderPeaks,
  resamplePeaks,
  useResponsiveBarCount,
} from "@shruti/composables/useWaveform.js"

/* -------------------------------------------------------------------------- */
/*           Module-level shared cache (intentional cross-instance)            */
/* -------------------------------------------------------------------------- */

/**
 * Caches survive scope re-mounts so navigating back to Notes restores
 * already-decoded peaks without re-fetching, and a noteId that was
 * played earlier re-hydrates its peaks the moment the row scrolls
 * back into view.
 */
const excerptUrlByNote = new Map<string, string>()
const peaksByNote = new Map<string, number[]>()
const inFlightDecodes = new Set<string>()
let sharedAudioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!sharedAudioContext) sharedAudioContext = new Ctor()
  return sharedAudioContext
}

/**
 * Downsample Float32 PCM into `WAVEFORM_RAW_PEAKS` peak buckets and
 * normalise to a 5-100% range so the bars span the container's height
 * without any near-zero peaks collapsing into invisible flat lines.
 * This is the high-resolution source the visible bars are resampled
 * from — see `resamplePeaks` — so it doesn't depend on screen width.
 */
function computePeaks(channel: Float32Array): number[] {
  const samplesPerBar = Math.max(1, Math.floor(channel.length / WAVEFORM_RAW_PEAKS))
  const peaks: number[] = []
  let maxPeak = 0
  for (let i = 0; i < WAVEFORM_RAW_PEAKS; i++) {
    const start = i * samplesPerBar
    const end = Math.min(start + samplesPerBar, channel.length)
    let peak = 0
    for (let j = start; j < end; j++) {
      const v = Math.abs(channel[j])
      if (v > peak) peak = v
    }
    peaks.push(peak)
    if (peak > maxPeak) maxPeak = peak
  }
  if (maxPeak === 0) return peaks.map(() => 5)
  return peaks.map((p) => Math.max(5, Math.round((p / maxPeak) * 100)))
}

/* -------------------------------------------------------------------------- */
/*                                Composable                                   */
/* -------------------------------------------------------------------------- */

export interface ExcerptRef {
  readonly noteId: string
  readonly sourceKey: string
  readonly timeStart: number
  readonly timeEnd: number
}

/**
 * The excerpt ref, or a getter returning the current ref. Prefer the
 * getter form when the consumer rebuilds the ref object on every render
 * (e.g. an inline `:note="{ … }"` literal whose `sourceKey` is filled in
 * asynchronously once tracks load): a plain-value `ref` is snapshotted at
 * setup and goes stale, so `resolveExcerptUrl()` would `cut()` with the
 * empty `sourceKey` from the very first render → `400 source_key required`.
 */
export type ExcerptRefSource = ExcerptRef | (() => ExcerptRef)

export interface UseExcerptWaveformOptions {
  readonly ref: ExcerptRefSource
  /** Template ref to the player's outer element — used as the
   *  IntersectionObserver target for lazy peak hydration. */
  readonly rootEl: Ref<HTMLElement | undefined | null>
  /** Template ref to the bars container — measured so the visible bar
   *  count tracks the available width instead of being fixed. */
  readonly waveformEl: Ref<HTMLElement | undefined | null>
  /** Produce (or resolve the cached) excerpt URL for the given window.
   *  The mobile app wires this to `shareAudioService.cut`; the web supplies
   *  its own POST adapter. `ready:false` means the excerpt is still being
   *  generated and the caller must HEAD-poll the URL before playing. */
  readonly cut: (args: {
    sourceKey: string
    startMs: number
    endMs: number
    excerptId: string
  }) => Promise<{ url: string; ready: boolean }>
  /** Predict the public CDN URL for an excerpt id without invoking `cut`. */
  readonly predictUrl: (noteId: string) => string
}

export interface UseExcerptWaveformReturn {
  /** Either the decoded peaks or the seeded placeholder. */
  readonly peaks: ComputedRef<number[]>
  /** True iff we've decoded the real audio (vs showing placeholder). */
  readonly hasRealPeaks: ComputedRef<boolean>
  /** Snapshot of the currently-known excerpt URL, or null if neither
   *  cut() has resolved nor a previous instance populated the cache.
   *  Consumers use this to skip the spinner when the URL is already
   *  available (resolveExcerptUrl returns instantly in that case). */
  readonly cachedUrl: () => string | null
  /**
   * Resolve the excerpt URL — re-uses the cached value if any, else
   * calls shareAudioService.cut(). Triggers a passive peak-decode in
   * the background.
   */
  readonly resolveExcerptUrl: () => Promise<string>
  /** Predict the CDN URL for the excerpt without invoking cut(). */
  readonly predictedExcerptUrl: () => string
}

/**
 * Reactive waveform for a Note's audio excerpt. Manages:
 *  - per-note shared caches (URLs + decoded peaks + in-flight set)
 *  - lazy on-visibility peak decode via IntersectionObserver
 *  - placeholder bars before peaks are available
 *  - cut+predict URL resolution
 *
 * Audio-element playback (play / pause / seek / time-update / etc.)
 * stays in the consumer .vue — this composable doesn't own the
 * HTMLAudioElement, only the data that paints the waveform under it.
 */
export function useExcerptWaveform(opts: UseExcerptWaveformOptions): UseExcerptWaveformReturn {
  const { rootEl } = opts
  // Read the ref FRESH on every access — never snapshot it. The consumer
  // may rebuild it each render with an async-filled `sourceKey`; a captured
  // copy would keep the first render's empty `sourceKey`. `noteId` is stable
  // per instance, so the setup-time reads below are safe either way.
  const refSource = opts.ref
  const getRef: () => ExcerptRef = typeof refSource === "function" ? refSource : () => refSource

  const realPeaks = ref<number[] | null>(peaksByNote.get(getRef().noteId) ?? null)
  const barCount = useResponsiveBarCount(opts.waveformEl)
  // Resample the high-res decoded peaks down to the bars the current
  // width calls for; before decode, build the placeholder directly at
  // that count so it fills the container at any screen size.
  const peaks = computed<number[]>(() =>
    realPeaks.value
      ? resamplePeaks(realPeaks.value, barCount.value)
      : buildPlaceholderPeaks(getRef().noteId, barCount.value)
  )
  const hasRealPeaks = computed(() => realPeaks.value !== null)

  let cachedUrl: string | null = excerptUrlByNote.get(getRef().noteId) ?? null
  let visible = false
  let observer: IntersectionObserver | null = null

  function predictedExcerptUrl(): string {
    return opts.predictUrl(getRef().noteId)
  }

  async function resolveExcerptUrl(): Promise<string> {
    if (cachedUrl) return cachedUrl
    const r = getRef()
    const result = await opts.cut({
      sourceKey: r.sourceKey,
      startMs: r.timeStart,
      endMs: r.timeEnd,
      excerptId: r.noteId,
    })
    cachedUrl = result.url || predictedExcerptUrl()
    // Server returns ready:false right after dispatching the background
    // cut; the audio element must wait for the upload to land or the
    // first play() races the worker and 404s.
    if (!result.ready) await pollUntilReady(cachedUrl, { timeoutMs: SHORT_POLL_TIMEOUT_MS })
    excerptUrlByNote.set(r.noteId, cachedUrl)
    void maybeLoadRealPeaks()
    return cachedUrl
  }

  /**
   * Try the predictable excerpt URL (public/shares/audio/{noteId}.mp3)
   * for this note. If it already exists on the CDN — because the user
   * (or another user) shared this note before — fetch the bytes and
   * decode the real peaks. If the file isn't there yet (404 / network
   * error), bail silently and keep the placeholder.
   *
   * Crucially this does NOT call shareAudioService.cut() — peak loading
   * is supposed to be passive on visibility, never a cost-incurring
   * Lambda invocation. cut() only runs when the user taps Play on a
   * note whose excerpt isn't on the CDN yet.
   */
  async function maybeLoadRealPeaks(): Promise<void> {
    const noteId = getRef().noteId
    if (peaksByNote.has(noteId)) {
      realPeaks.value = peaksByNote.get(noteId)!
      return
    }
    if (!visible) return
    if (inFlightDecodes.has(noteId)) return
    const ctx = getAudioContext()
    if (!ctx) return
    inFlightDecodes.add(noteId)
    try {
      const url = excerptUrlByNote.get(noteId) ?? predictedExcerptUrl()
      const response = await fetch(url)
      if (!response.ok) return // excerpt not generated yet — keep placeholder
      excerptUrlByNote.set(noteId, url)
      if (!cachedUrl) cachedUrl = url
      const buf = await response.arrayBuffer()
      const decoded = await ctx.decodeAudioData(buf)
      const channel = decoded.getChannelData(0)
      const computed = computePeaks(channel)
      peaksByNote.set(noteId, computed)
      realPeaks.value = computed
    } catch (err) {
      console.warn("[useExcerptWaveform] peak decode failed:", err)
    } finally {
      inFlightDecodes.delete(noteId)
    }
  }

  onMounted(() => {
    if (typeof IntersectionObserver === "undefined" || !rootEl.value) {
      // Conservative fallback: assume visible.
      visible = true
      void maybeLoadRealPeaks()
      return
    }
    observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        visible = entry.isIntersecting
        if (visible) void maybeLoadRealPeaks()
      },
      { rootMargin: "200px 0px", threshold: 0 }
    )
    observer.observe(rootEl.value)
  })

  onBeforeUnmount(() => {
    observer?.disconnect()
  })

  return {
    peaks,
    hasRealPeaks,
    cachedUrl: () => cachedUrl,
    resolveExcerptUrl,
    predictedExcerptUrl,
  }
}
