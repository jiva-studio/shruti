<script setup lang="ts">
import { computed, ref } from "vue"
import { IonSpinner } from "@ionic/vue"
import { useExcerptAudioPlayer } from "@lib/chat/audio/useExcerptAudioPlayer.js"
import { useCachedExcerptUrl } from "@lectorium/composables/useCachedExcerptUrl.js"
import type { ChatVerseBody } from "@lib/domain/chatMessage.js"
import VerseCard from "@lib/ui/chat/VerseCard.vue"

const props = defineProps<{
  sourceId: string
  tokens: string
  caption?: string
  body?: ChatVerseBody
  locale: string
}>()

// Whole-file recitation public URL (no excerpt cut). Routed through the
// excerpt cache: the first tap downloads the mp3, later taps + offline play
// the local copy.
const audioUrl = computed(() => props.body?.audioUrl || "")

const localUri = ref<string | null>(null)
const { resolve: resolveCachedUrl } = useCachedExcerptUrl()

async function resolveVerseAudio(): Promise<string> {
  const url = await resolveCachedUrl(() => audioUrl.value)
  localUri.value = url
  return url
}

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
  cachedUrl: () => localUri.value,
  resolveUrl: resolveVerseAudio,
  logLabel: "verse-audio",
})
</script>

<template>
  <!--
    Host container for the pure VerseCard. Owns the recitation audio the card
    used to run internally: the hidden <audio> element + the download-once /
    play-from-disk excerpt cache (useExcerptAudioPlayer). The card stays a
    presentational leaf — see @lib/ui/chat/VerseCard.vue.
  -->
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
    <template #spinner><IonSpinner name="crescent" class="verse-play-spin" /></template>
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

<style scoped>
.verse-play-spin {
  width: 12px;
  height: 12px;
  --color: var(--ion-color-primary);
}
</style>
