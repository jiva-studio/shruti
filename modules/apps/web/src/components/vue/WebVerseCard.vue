<template>
  <VerseCard
    :source-id="sourceId"
    :tokens="tokens"
    :caption="caption"
    :body="body"
    :locale="locale"
    :has-audio="!!audioUrl"
    :is-playing="isPlaying"
    :is-preparing="isPreparing"
    @toggle-audio="onToggle"
  >
    <template #spinner><span class="dots-spinner" /></template>
  </VerseCard>
  <audio
    v-if="audioUrl"
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
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useExcerptAudioPlayer } from '@lib/chat/audio/useExcerptAudioPlayer.js'
import VerseCard from '@lib/ui/chat/VerseCard.vue'
import type { VersePayload } from './types/chat'

const props = defineProps<{
  sourceId: string
  tokens: string
  caption?: string
  body?: VersePayload
  locale: string
}>()

const audioUrl = computed<string>(() => props.body?.audioUrl || '')

const {
  audioEl,
  isPlaying,
  isPreparing,
  onToggle,
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
  hasSource: () => !!audioUrl.value,
  cachedUrl: () => audioUrl.value || null,
  resolveUrl: async () => audioUrl.value,
  logLabel: 'web-verse-audio',
})
</script>
