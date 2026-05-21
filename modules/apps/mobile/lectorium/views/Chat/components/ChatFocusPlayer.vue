<template>
  <div class="focus-player">
    <button
      type="button"
      class="play-btn"
      :aria-label="isPlaying ? 'Pause' : 'Play'"
      :disabled="isPreparing || !sourceKey"
      @click="onToggle"
    >
      <IonSpinner v-if="isPreparing" name="crescent" class="play-btn-spinner" />
      <IconPlayerPauseFilled v-else-if="isPlaying" :size="18" />
      <IconPlayerPlayFilled v-else :size="18" />
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
    <span class="range-label">{{ rangeLabel }}</span>
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
/**
 * Thin audio scrubber for the chat focus card. Mirrors the notes
 * inline player's UX (play button + waveform + tap-to-seek) but stays
 * narrow on purpose:
 *
 *   - placeholder peaks only, no AudioContext decode pass. The card is
 *     typically the only player in view, so lazy peak loading would be
 *     UX overkill. If we ever surface focus cards in a dense list we
 *     can borrow NotesInlinePlayer's IntersectionObserver decode.
 *   - excerptId = the chat message id, so the same fragment in
 *     different sessions gets distinct cached cuts. Matches the
 *     notes-side pattern (`noteId` as excerpt id).
 *
 * Inputs are deliberately minimal: the parent ChatFocusCard already
 * has the focus payload — we receive just what the player needs.
 */
import { computed, onBeforeUnmount, ref, useTemplateRef } from "vue"
import { IonSpinner } from "@ionic/vue"
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useNotesInlineAudio } from "@lectorium/composables/useNotesInlineAudio.js"

const BAR_COUNT = 96

const props = defineProps<{
  /** Stable id used as excerptId for the share-audio cut + as a seed
   *  for the placeholder waveform. The chat message id is a fine fit. */
  messageId: string
  /** Source-audio bucket key the cutter slices. Optional because not
   *  every legacy focus message carries it — the button stays disabled
   *  in that case rather than throwing on tap. */
  sourceKey?: string
  startMs: number
  endMs: number
}>()

const app = useLectorium()
const inline = useNotesInlineAudio()
const audioEl = useTemplateRef<HTMLAudioElement>("audioEl")

const isPlaying = ref(false)
const isPreparing = ref(false)
const positionMs = ref(0)
const durationMs = ref(0)

const peaks = computed<number[]>(() => buildPlaceholderPeaks(props.messageId))

const progressFraction = computed(() => {
  if (durationMs.value <= 0) return 0
  return Math.min(1, Math.max(0, positionMs.value / durationMs.value))
})

const rangeLabel = computed(() => {
  return `${formatMs(props.startMs)}–${formatMs(props.endMs)}`
})

let cachedUrl: string | null = null

async function resolveExcerptUrl(): Promise<string> {
  if (cachedUrl) return cachedUrl
  if (!props.sourceKey) {
    throw new Error("focus-player: missing sourceKey")
  }
  const result = await app.shareAudioService.cut({
    sourceKey: props.sourceKey,
    startMs: props.startMs,
    endMs: props.endMs,
    excerptId: props.messageId,
  })
  cachedUrl = result.url
  return cachedUrl
}

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
  if (!props.sourceKey) {
    console.warn("[focus-player] missing source key", props.messageId)
    return
  }
  if (!cachedUrl) {
    isPreparing.value = true
    try {
      el.src = await resolveExcerptUrl()
    } catch (err) {
      isPreparing.value = false
      console.warn("[focus-player] cut failed:", err)
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
    console.warn("[focus-player] play failed:", err)
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
  unregister()
  audioEl.value?.pause()
})

function formatMs(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

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
</script>

<style scoped>
.focus-player {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  background: rgba(var(--ion-color-medium-rgb), 0.06);
  border-radius: 10px;
}

.play-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.play-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.play-btn-spinner {
  --color: var(--ion-color-primary-contrast);
  width: 14px;
  height: 14px;
}

.waveform {
  flex: 1;
  height: 28px;
  display: flex;
  align-items: center;
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
  background: rgba(var(--ion-color-medium-rgb), 0.4);
  border-radius: 2px;
  transition: background 80ms linear;
}

.bar.is-played {
  background: var(--ion-color-primary);
}

.range-label {
  flex-shrink: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ion-color-medium);
  letter-spacing: 0.02em;
}
</style>
