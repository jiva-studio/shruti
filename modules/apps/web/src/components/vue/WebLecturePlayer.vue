<template>
  <div class="lecture-player" :style="{ '--dock-top': stickyTop }">
    <div class="player-dock">
      <AudioPlayerBar
        :playing="playing"
        :position-ms="positionMs"
        :duration-ms="durationMs"
        :speed="speed"
        :busy="busy"
        @toggle="toggle"
        @skip-back="skipBack"
        @skip-forward="skipForward"
        @seek="seek"
        @update:speed="setSpeed"
      >
        <template #spinner><span class="dots-spinner" /></template>
        <template #waveform>
          <div class="lw-bars">
            <Waveform
              ref="waveformRef"
              :peaks="peaks"
              :progress-fraction="progressFraction"
              :chapters="chapters"
              :duration-ms="durationMs"
              :position-ms="positionMs"
              @seek="onWaveformClick"
              @chapter-seek="seek"
              @chapter-hover="onMarkerHover"
            />
          </div>
        </template>
        <template #below>
          <div v-if="captionTitle" class="lw-caption">
            <span class="lw-dot" />
            <span>{{ captionTitle }}</span>
          </div>
        </template>
      </AudioPlayerBar>
    </div>

    <div v-if="chapters.length" class="chapters">
      <h2 class="chapters-title">{{ t('chapters') }}</h2>
      <ol class="chapters-list">
        <li v-for="(ch, i) in chapters" :key="i">
          <button type="button" class="chapter-row" @click="seek(ch.startMs)">
            <span class="chapter-time">{{ formatTime(ch.startMs) }}</span>
            <span class="chapter-title">{{ ch.title }}</span>
          </button>
        </li>
      </ol>
    </div>

    <div class="transcript">
      <p v-if="!groups.length" class="transcript-empty">{{ t('noTranscript') }}</p>
      <TranscriptView
        v-else
        ref="transcriptEl"
        :groups="groups"
        :position-ms="positionMs"
        @seek="seek"
      />
    </div>

    <audio
      ref="audioEl"
      :src="audioUrl"
      preload="metadata"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoadedMetadata"
      @play="onPlay"
      @pause="onPause"
      @ended="onEnded"
      @waiting="onWaiting"
      @playing="onPlaying"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useTemplateRef, watch } from 'vue'
import type { LectureRecord, LectureVariant, OutlineChapter } from '@lib/catalog/types.js'
import { buildTranscriptGroups } from '@lib/catalog/transcript.js'
import AudioPlayerBar from '@lib/ui/player/AudioPlayerBar.vue'
import TranscriptView from '@lib/ui/transcript/TranscriptView.vue'
import Waveform from '@lib/ui/player/Waveform.vue'
import { buildPlaceholderPeaks, resamplePeaks, useResponsiveBarCount } from '@lib/chat/audio/useWaveform.js'
import { useLectureAudioPlayer } from '../../composables/useLectureAudioPlayer'
import { useT } from '../../i18n/ui'

const props = withDefaults(
  defineProps<{
    lecture: LectureRecord
    lang: 'ru' | 'en'
    stickyTop?: string
  }>(),
  { stickyTop: '4.5rem' }
)

const tr = useT(props.lang)
function t(key: string): string {
  return tr(`lecture.${key}` as never)
}

const variant = computed<LectureVariant | null>(() => {
  const v = props.lecture.variants
  return v[props.lang] ?? Object.values(v)[0] ?? null
})

const audioUrl = computed(() => variant.value?.audio?.url ?? '')
const chapters = computed<OutlineChapter[]>(() => variant.value?.outline ?? [])

const groups = computed(() => {
  const v = variant.value
  if (!v || !v.transcript || !v.transcript.blocks.length) return []
  return buildTranscriptGroups(v.transcript.blocks, v.outline ?? [])
})

const transcriptEl = useTemplateRef<{ $el: HTMLElement }>('transcriptEl')
const waveformRef = useTemplateRef<{ waveformEl: HTMLElement | null }>('waveformRef')
const waveformEl = computed<HTMLElement | null>(() => waveformRef.value?.waveformEl ?? null)

const {
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
} = useLectureAudioPlayer({ initialDurationMs: variant.value?.audio?.durationMs ?? 0 })

const barCount = useResponsiveBarCount(waveformEl)
const rawPeaks = computed(() => buildPlaceholderPeaks(props.lecture.id, 400))
const peaks = computed(() => resamplePeaks(rawPeaks.value, barCount.value))
const progressFraction = computed(() => {
  if (!durationMs.value || durationMs.value <= 0) return 0
  const f = positionMs.value / durationMs.value
  return f < 0 ? 0 : f > 1 ? 1 : f
})

function onWaveformClick(event: MouseEvent) {
  const el = waveformEl.value
  if (!el || !durationMs.value) return
  const rect = el.getBoundingClientRect()
  let f = (event.clientX - rect.left) / rect.width
  if (f < 0) f = 0
  if (f > 1) f = 1
  seek(Math.round(f * durationMs.value))
}

const hoverTitle = ref<string | null>(null)
function onMarkerHover(title: string | null) {
  hoverTitle.value = title
}

const activeChapterTitle = computed<string | null>(() => {
  let title: string | null = null
  for (const ch of chapters.value) {
    if (ch.startMs <= positionMs.value) title = ch.title
    else break
  }
  return title
})

const captionTitle = computed(() => hoverTitle.value ?? activeChapterTitle.value)

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor((ms || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

let lastScroll = 0
let activeIndex = -1

watch(positionMs, (pos) => {
  const idx = groups.value.findIndex((g) => g.startMs <= pos && pos <= g.endMs)
  if (idx === -1 || idx === activeIndex) return
  activeIndex = idx
  const now = Date.now()
  if (now - lastScroll < 400) return
  lastScroll = now
  const root = transcriptEl.value?.$el
  if (!root) return
  const para = root.querySelectorAll('.tx-group')[idx] as HTMLElement | undefined
  if (para && playing.value) para.scrollIntoView({ behavior: 'smooth', block: 'center' })
})
</script>

<style scoped>
.lecture-player {
  display: flex;
  flex-direction: column;
}

.player-dock {
  position: sticky;
  top: var(--dock-top, 4.5rem);
  z-index: 30;
  padding: 12px 0;
  background: var(--ion-background-color);
}

.lw-bars {
  position: relative;
  display: flex;
  width: 100%;
  --waveform-height: 40px;
  --waveform-base: rgba(var(--ion-color-medium-rgb), 0.28);
  --waveform-played: var(--ion-color-primary);
}

.lw-caption {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 1.2em;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--ion-color-primary);
  line-height: 1.3;
}

.lw-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ion-color-primary);
}

.chapters {
  margin-top: 24px;
}

.chapters-title {
  font-family: var(--font-serif, serif);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--ion-text-color);
  margin-bottom: 12px;
}

.chapters-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.chapter-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  width: 100%;
  padding: 2px 10px;
  border: none;
  background: transparent;
  text-align: left;
  border-radius: 8px;
  line-height: 1.3;
  cursor: pointer;
  transition: background 150ms ease;
}

.chapter-row:hover {
  background: rgba(var(--ion-color-medium-rgb), 0.08);
}

.chapter-time {
  flex-shrink: 0;
  min-width: 4.5em;
  text-align: right;
  font-size: 0.78rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--ion-color-primary);
}

.chapter-title {
  color: var(--ion-text-color);
}

.transcript {
  margin-top: 28px;
}

.transcript-empty {
  color: var(--ion-color-medium);
}
</style>
