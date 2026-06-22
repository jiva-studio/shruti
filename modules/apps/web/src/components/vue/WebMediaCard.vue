<template>
  <MediaCard
    :payload="payload"
    :is-playing="playing"
    :progress-fraction="progress"
    :buffered-fraction="buffered"
    :transcript-text="transcriptText"
    :is-mt="isMt"
    :show-original="showOriginal"
    @toggle="toggle"
    @seek="onSeek"
    @update:show-original="showOriginal = $event"
  >
    <template #media>
      <video
        v-if="payload?.type === 'video'"
        ref="mediaEl"
        class="media-card-media"
        playsinline
        preload="metadata"
        :poster="posterUrl"
        :src="fileUrl"
        @click="toggle"
        @play="playing = true"
        @pause="playing = false"
        @ended="playing = false"
        @timeupdate="onTimeUpdate"
        @progress="onProgress"
        @loadedmetadata="onProgress"
      />
      <audio
        v-else
        ref="mediaEl"
        preload="metadata"
        :src="fileUrl"
        @play="playing = true"
        @pause="playing = false"
        @ended="playing = false"
        @timeupdate="onTimeUpdate"
        @progress="onProgress"
        @loadedmetadata="onProgress"
      />
    </template>
    <template #play-icon="{ size }">
      <svg viewBox="0 0 24 24" :width="size" :height="size" fill="currentColor" aria-hidden="true"><path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z" /></svg>
    </template>
    <template #pause-icon="{ size }">
      <svg viewBox="0 0 24 24" :width="size" :height="size" fill="currentColor" aria-hidden="true"><path d="M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" /><path d="M17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" /></svg>
    </template>
    <template #expand-icon="{ size }">
      <svg viewBox="0 0 24 24" :width="size" :height="size" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6l6 -6" /></svg>
    </template>
  </MediaCard>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAudioSource } from '@lib/chat/audio/useAudioOrchestrator.js'
import MediaCard from '@lib/ui/chat/MediaCard.vue'

const props = defineProps<{ payload?: any }>()

const mediaEl = ref<HTMLVideoElement | HTMLAudioElement | null>(null)
const playing = ref(false)
const progress = ref(0)
const buffered = ref(0)
const showOriginal = ref(false)

const isMt = computed<boolean>(() => !!props.payload?.mt && !!props.payload?.textOriginal)
const transcriptText = computed<string>(() => {
  const p = props.payload
  if (!p) return ''
  return showOriginal.value && p.textOriginal ? p.textOriginal : p.text
})

const fileUrl = computed<string>(() => props.payload?.url ?? '')
const posterUrl = computed<string>(() =>
  props.payload ? String(props.payload.url).replace(/\.[^./]+$/, '.jpg') : ''
)

function onTimeUpdate(): void {
  const el = mediaEl.value
  progress.value = el && el.duration > 0 ? el.currentTime / el.duration : 0
  onProgress()
}

function onProgress(): void {
  const el = mediaEl.value
  if (!el || el.duration <= 0 || el.buffered.length === 0) {
    buffered.value = 0
    return
  }
  let end = 0
  for (let i = 0; i < el.buffered.length; i++) {
    if (el.buffered.start(i) <= el.currentTime && el.currentTime <= el.buffered.end(i)) {
      end = el.buffered.end(i)
      break
    }
    end = Math.max(end, el.buffered.end(i))
  }
  buffered.value = end / el.duration
}

function onSeek(ratio: number): void {
  const el = mediaEl.value
  if (!el || !el.duration) return
  el.currentTime = el.duration * Math.min(1, Math.max(0, ratio))
}

const { claim } = useAudioSource('inline', () => mediaEl.value?.pause())

async function toggle(): Promise<void> {
  const el = mediaEl.value
  if (!el) return
  if (!el.paused) {
    el.pause()
    return
  }
  claim()
  try {
    await el.play()
  } catch {
    // autoplay/buffer hiccup — user can tap again
  }
}
</script>
