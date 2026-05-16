<template>
  <div ref="rootEl" class="notes-inline-player">
    <button
      type="button"
      class="play-btn"
      :aria-label="isPlaying ? 'Pause' : 'Play'"
      :disabled="isPreparing"
      @click="onToggle"
    >
      <IonSpinner v-if="isPreparing" name="crescent" class="play-btn-spinner" />
      <IconPlayerPauseFilled v-else-if="isPlaying" :size="16" />
      <IconPlayerPlayFilled v-else :size="16" />
    </button>
    <div class="waveform" aria-hidden="true" @click="onWaveformClick">
      <span
        v-for="(h, i) in peaks"
        :key="i"
        class="bar"
        :class="{ 'is-played': i / peaks.length < progressFraction }"
        :style="{ height: h + '%' }"
      />
    </div>
    <audio
      ref="audioEl"
      preload="none"
      @ended="onEnded"
      @pause="onPause"
      @play="onPlay"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onMetadata"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue"
import { IonSpinner } from "@ionic/vue"
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { buildServerUrl } from "@lib/domain/servers.js"
import { useShruti } from "@shruti/shruti.js"
import { useNotesInlineAudio } from "@shruti/composables/useNotesInlineAudio.js"

const BAR_COUNT = 96

/**
 * Module-scoped caches so navigating back to Notes restores already-
 * decoded peaks without re-fetching, and so a noteId that was played
 * earlier can re-hydrate its peaks from the URL the moment the row
 * comes into view.
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

interface NoteAudioRef {
  readonly noteId: string
  readonly trackId: string
  readonly sourceKey: string
  readonly timeStart: number
  readonly timeEnd: number
}

const props = defineProps<{ note: NoteAudioRef }>()

const app = useShruti()
const inline = useNotesInlineAudio()
const audioEl = useTemplateRef<HTMLAudioElement>("audioEl")
const rootEl = useTemplateRef<HTMLDivElement>("rootEl")

const isPlaying = ref(false)
const isPreparing = ref(false)
const positionMs = ref(0)
const durationMs = ref(0)
const realPeaks = ref<number[] | null>(peaksByNote.get(props.note.noteId) ?? null)
const placeholder = computed(() => buildPlaceholderPeaks(props.note.noteId))

const peaks = computed<number[]>(() => realPeaks.value ?? placeholder.value)

const progressFraction = computed(() => {
  if (durationMs.value <= 0) return 0
  return Math.min(1, Math.max(0, positionMs.value / durationMs.value))
})

let cachedUrl: string | null = excerptUrlByNote.get(props.note.noteId) ?? null
let visible = false
let observer: IntersectionObserver | null = null

function predictedExcerptUrl(): string {
  return buildServerUrl(app.activeServer.value, `public/shares/audio/${props.note.noteId}.mp3`)
}

async function resolveExcerptUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl
  const result = await app.shareAudioService.cut({
    sourceKey: props.note.sourceKey,
    startMs: props.note.timeStart,
    endMs: props.note.timeEnd,
    excerptId: props.note.noteId,
  })
  cachedUrl = result.url || predictedExcerptUrl()
  excerptUrlByNote.set(props.note.noteId, cachedUrl)
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
  const noteId = props.note.noteId
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
    console.warn("[notes-inline-player] peak decode failed:", err)
  } finally {
    inFlightDecodes.delete(noteId)
  }
}

/**
 * Pause this player AND rewind it to the start. When another inline
 * player on the page (or the main lecture, via App.vue) signals that
 * it's about to play, all other inline players should reset to their
 * initial state — leaving them mid-clip / mid-pause means the user sees
 * "multiple players in different positions, none at the beginning."
 *
 * The main lecture player intentionally keeps its position (registered
 * with its own pause-only callback in App.vue) so a tap on a note
 * excerpt doesn't lose the lecture's resume point.
 */
function pauseAndResetSelf(): void {
  const el = audioEl.value
  if (!el) return
  el.pause()
  el.currentTime = 0
  positionMs.value = 0
}

const unregister = inline.registerPauser(pauseAndResetSelf)

async function onToggle(): Promise<void> {
  const el = audioEl.value
  if (!el) return
  if (isPlaying.value) {
    el.pause()
    return
  }
  if (!props.note.sourceKey) {
    console.warn("[notes-inline-player] missing source audio path for note", props.note.noteId)
    return
  }
  if (!cachedUrl) {
    isPreparing.value = true
    try {
      el.src = await resolveExcerptUrl()
    } catch (err) {
      isPreparing.value = false
      console.warn("[notes-inline-player] cut failed:", err)
      return
    }
    isPreparing.value = false
  } else if (!el.src) {
    el.src = cachedUrl
  }
  inline.notifyPlaying(pauseAndResetSelf)
  try {
    await el.play()
  } catch (err) {
    console.warn("[notes-inline-player] play failed:", err)
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
  unregister()
  observer?.disconnect()
  audioEl.value?.pause()
})
</script>

<style scoped>
.notes-inline-player {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  background: rgba(var(--ion-color-medium-rgb), 0.06);
  border-radius: 8px;
  margin-bottom: 8px;
}

.play-btn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--ion-color-medium);
  color: var(--ion-color-medium-contrast);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.play-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.play-btn-spinner {
  --color: var(--ion-color-medium-contrast);
  width: 14px;
  height: 14px;
}

.waveform {
  flex: 1;
  height: 24px;
  display: flex;
  align-items: center;
  /* `space-between` makes the 96 fixed-width (2 px) bars span the
     full container width: the leftover horizontal space is divided
     equally between bars instead of collapsing into a single trailing
     gap on the right. Drops the explicit `gap` for the same reason. */
  justify-content: space-between;
  min-width: 0;
  overflow: hidden;
  cursor: pointer;
}

.bar {
  display: inline-block;
  flex: 0 0 2px;
  width: 2px;
  min-height: 2px;
  background: rgba(var(--ion-color-medium-rgb), 0.35);
  border-radius: 2px;
  /* `height` transitions so the swap from the random placeholder peaks
   * to the real decoded peaks reads as a wave settling into shape
   * rather than a hard jump. Bar count is constant (`BAR_COUNT = 96`),
   * so Vue updates inline styles in place and CSS handles the tween. */
  transition:
    background 80ms linear,
    height 350ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.bar.is-played {
  background: var(--ion-color-medium);
}
</style>
