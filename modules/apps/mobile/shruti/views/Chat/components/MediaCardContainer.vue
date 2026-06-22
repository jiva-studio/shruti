<template>
  <!--
    Host container for the pure MediaCard. Owns the media element (<video> /
    <audio>), the audio orchestrator (one sound at a time), URL resolution,
    and the progress/buffer tracking the card used to run internally. The
    card stays a presentational shell fed isPlaying / progress / transcript.
  -->
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
    <template #play-icon="{ size }"><slot name="play-icon" :size="size" /></template>
    <template #pause-icon="{ size }"><slot name="pause-icon" :size="size" /></template>
    <template #expand-icon="{ size }"><slot name="expand-icon" :size="size" /></template>
  </MediaCard>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { useAudioSource } from "@lib/chat/audio/useAudioOrchestrator.js"
import type { MediaPayload } from "@lib/domain/chatMessage.js"
import MediaCard from "@lib/ui/chat/MediaCard.vue"

const props = defineProps<{
  payload?: MediaPayload
  /** Turns a RELATIVE storage path (`payload.url`) into an absolute URL —
   *  the mobile app passes `storagePublicUrl.get`. */
  resolveUrl?: (path: string) => string
}>()

const mediaEl = ref<HTMLVideoElement | HTMLAudioElement | null>(null)
const playing = ref(false)
const progress = ref(0)
const buffered = ref(0)
const showOriginal = ref(false)

const isMt = computed<boolean>(() => !!props.payload?.mt && !!props.payload?.textOriginal)
const transcriptText = computed<string>(() => {
  const p = props.payload
  if (!p) return ""
  return showOriginal.value && p.textOriginal ? p.textOriginal : p.text
})

const resolve = (path: string): string => (props.resolveUrl ? props.resolveUrl(path) : path)
const fileUrl = computed(() => (props.payload ? resolve(props.payload.url) : ""))
const posterUrl = computed(() => {
  if (!props.payload) return ""
  return resolve(props.payload.url.replace(/\.[^./]+$/, ".jpg"))
})

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

// One sound at a time: when anything else claims audio, pause ourselves;
// when WE start, claim() pauses the lecture + every other snippet.
const { claim } = useAudioSource("inline", () => mediaEl.value?.pause())

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
