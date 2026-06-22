<template>
  <!--
    Host container for the pure ExcerptPlayer. Owns the audio element +
    excerpt cut/cache (useExcerptAudioPlayer) and the waveform peak decode
    (useExcerptWaveform); the player is a presentational leaf fed
    peaks / progress / play state and emitting toggle / seek.
  -->
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
      <template #spinner><slot name="spinner" /></template>
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
import { computed, useTemplateRef } from "vue"
import { useExcerptAudioPlayer } from "@lib/chat/audio/useExcerptAudioPlayer.js"
import { useExcerptWaveform, type ExcerptRef } from "@lib/chat/audio/useExcerptWaveform.js"
import ExcerptPlayer from "@lib/ui/chat/ExcerptPlayer.vue"

interface NoteAudioRef extends ExcerptRef {
  readonly trackId: string
}

const props = defineProps<{
  note: NoteAudioRef
  active?: boolean
  cut: (args: {
    sourceKey: string
    startMs: number
    endMs: number
    excerptId: string
  }) => Promise<{ url: string; ready: boolean }>
  predictUrl: (noteId: string) => string
}>()

const rootEl = useTemplateRef<HTMLDivElement>("rootEl")
const playerEl = useTemplateRef<{ waveformEl: HTMLElement | null }>("playerEl")
const waveformEl = computed<HTMLElement | null>(() => playerEl.value?.waveformEl ?? null)

const { peaks, cachedUrl, resolveExcerptUrl } = useExcerptWaveform({
  // Getter form: `props.note` is rebuilt each render (inline literal in
  // NotesView) and its `sourceKey` is empty until tracks finish loading.
  // Passing the value directly would snapshot that empty key and `cut()`
  // would fail with `400 source_key required`.
  ref: () => props.note,
  rootEl,
  waveformEl,
  cut: props.cut,
  predictUrl: props.predictUrl,
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
  hasSource: () => !!props.note.sourceKey,
  cachedUrl,
  resolveUrl: resolveExcerptUrl,
  logLabel: "notes-inline-player",
  active: () => props.active ?? true,
})
</script>
