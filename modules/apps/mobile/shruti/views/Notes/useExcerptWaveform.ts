import { computed, onBeforeUnmount, onMounted, ref, type ComputedRef, type Ref } from "vue"
import { buildServerUrl } from "@lib/domain/servers.js"
import { useShruti } from "@shruti/shruti.js"
import { pollUntilReady } from "@shruti/services/pollUntilReady.js"

const BAR_COUNT = 96

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
 * Per-note (seeded by id) so every row keeps a recognisable shape even
 * before its excerpt has been generated.
 */
function buildPlaceholderPeaks(seed: string): number[] {
  const rand = mulberry32(hashStringTo32(seed) || 1)
  const out: number[] = []
  for (let i = 0; i < BAR_COUNT; i++) {
    const r = rand()
    let h: number
    if (r < 0.1) h = 4 + rand() * 12
    else if (r > 0.875) h = 80 + rand() * 18
    else h = 25 + rand() * 50
    out.push(Math.round(h))
  }
  return out
}

/**
 * Downsample Float32 PCM into `BAR_COUNT` peak buckets and normalise
 * to a 5-100% range so the bars span the container's height without
 * any near-zero peaks collapsing into invisible flat lines.
 */
function computePeaks(channel: Float32Array): number[] {
  const samplesPerBar = Math.max(1, Math.floor(channel.length / BAR_COUNT))
  const peaks: number[] = []
  let maxPeak = 0
  for (let i = 0; i < BAR_COUNT; i++) {
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

export interface UseExcerptWaveformOptions {
  readonly ref: ExcerptRef
  /** Template ref to the player's outer element — used as the
   *  IntersectionObserver target for lazy peak hydration. */
  readonly rootEl: Ref<HTMLElement | undefined | null>
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
  const app = useShruti()
  const { ref: noteRef, rootEl } = opts

  const realPeaks = ref<number[] | null>(peaksByNote.get(noteRef.noteId) ?? null)
  const placeholder = computed(() => buildPlaceholderPeaks(noteRef.noteId))
  const peaks = computed<number[]>(() => realPeaks.value ?? placeholder.value)
  const hasRealPeaks = computed(() => realPeaks.value !== null)

  let cachedUrl: string | null = excerptUrlByNote.get(noteRef.noteId) ?? null
  let visible = false
  let observer: IntersectionObserver | null = null

  function predictedExcerptUrl(): string {
    return buildServerUrl(app.activeServer.value, `public/shares/audio/${noteRef.noteId}.mp3`)
  }

  async function resolveExcerptUrl(): Promise<string> {
    if (cachedUrl) return cachedUrl
    const result = await app.shareAudioService.cut({
      sourceKey: noteRef.sourceKey,
      startMs: noteRef.timeStart,
      endMs: noteRef.timeEnd,
      excerptId: noteRef.noteId,
    })
    cachedUrl = result.url || predictedExcerptUrl()
    // Server returns ready:false right after dispatching the background
    // cut; the audio element must wait for the upload to land or the
    // first play() races the worker and 404s.
    if (!result.ready) await pollUntilReady(cachedUrl)
    excerptUrlByNote.set(noteRef.noteId, cachedUrl)
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
    const noteId = noteRef.noteId
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
