<template>
  <div ref="rootEl">
    <ExcerptPlayer
      ref="playerEl"
      :peaks="peaks"
      :progress-fraction="progressFraction"
      :is-playing="isPlaying"
      :is-preparing="isPreparing"
      @toggle="onToggle"
      @seek="onWaveformClick"
    >
      <template #spinner><span class="dots-spinner" /></template>
    </ExcerptPlayer>
    <audio
      ref="audioEl"
      preload="none"
      @ended="onEnded"
      @pause="onPause"
      @play="onPlay"
      @playing="onPlaying"
      @canplay="onCanPlay"
      @waiting="onWaiting"
      @stalled="onWaiting"
      @error="onError"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onMetadata"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, useTemplateRef } from 'vue'
import { useExcerptAudioPlayer } from '@lib/chat/audio/useExcerptAudioPlayer.js'
import { useExcerptWaveform, type ExcerptRef } from '@lib/chat/audio/useExcerptWaveform.js'
import ExcerptPlayer from '@lib/ui/chat/ExcerptPlayer.vue'

const props = defineProps<{
  noteId: string
  sourceKey: string
  timeStart: number
  timeEnd: number
}>()

const CHAT = (import.meta.env.PUBLIC_CHAT_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''
const S3_BASE = 'https://cdn-s3.shruti.local'

async function webCut(args: {
  sourceKey: string
  startMs: number
  endMs: number
  excerptId: string
}): Promise<{ url: string; ready: boolean }> {
  const r = await fetch(`${CHAT}/share/audio/excerpts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_key: args.sourceKey,
      start_ms: args.startMs,
      end_ms: args.endMs,
      excerpt_id: args.excerptId,
    }),
  })
  if (!r.ok && r.status !== 202) throw new Error('cut_failed')
  const j = await r.json()
  return { url: j.url, ready: j.ready }
}

function predictUrl(id: string): string {
  return `${S3_BASE}/public/shares/audio/${id}.mp3`
}

const noteRef = computed<ExcerptRef>(() => ({
  noteId: props.noteId,
  sourceKey: props.sourceKey,
  timeStart: props.timeStart,
  timeEnd: props.timeEnd,
}))

const rootEl = useTemplateRef<HTMLDivElement>('rootEl')
const playerEl = useTemplateRef<{ waveformEl: HTMLElement | null }>('playerEl')
const waveformEl = computed<HTMLElement | null>(() => playerEl.value?.waveformEl ?? null)

const { peaks, cachedUrl, resolveExcerptUrl } = useExcerptWaveform({
  ref: () => noteRef.value,
  rootEl,
  waveformEl,
  cut: webCut,
  predictUrl,
})

const {
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
} = useExcerptAudioPlayer({
  hasSource: () => !!noteRef.value.sourceKey,
  cachedUrl,
  resolveUrl: resolveExcerptUrl,
  logLabel: 'web-excerpt-player',
})
</script>
