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
    <div ref="waveformEl" class="waveform" aria-hidden="true" @click="onWaveformClick">
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
import { computed, useTemplateRef } from "vue"
import { IonSpinner } from "@ionic/vue"
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useExcerptAudioPlayer } from "@lectorium/composables/useExcerptAudioPlayer.js"
import { pollUntilReady } from "@lectorium/services/pollUntilReady.js"
import { buildPlaceholderPeaks, useResponsiveBarCount } from "@lectorium/composables/useWaveform.js"

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
// Bars container — measured by useResponsiveBarCount so the placeholder
// peak count tracks the available width. The audio element + playback
// state come from useExcerptAudioPlayer below.
const waveformEl = useTemplateRef<HTMLDivElement>("waveformEl")

const barCount = useResponsiveBarCount(waveformEl)
const peaks = computed<number[]>(() => buildPlaceholderPeaks(props.messageId, barCount.value))

let cachedExcerptUrl: string | null = null

async function resolveExcerptUrl(): Promise<string> {
  if (cachedExcerptUrl) return cachedExcerptUrl
  if (!props.sourceKey) {
    throw new Error("focus-player: missing sourceKey")
  }
  const result = await app.shareAudioService.cut({
    sourceKey: props.sourceKey,
    startMs: props.startMs,
    endMs: props.endMs,
    excerptId: props.messageId,
  })
  cachedExcerptUrl = result.url
  // Server now answers 202 ready:false the moment it dispatches the
  // background cut; the file lands on S3 a beat later. Without this
  // poll the <audio> element would hit a 404 on the first play.
  if (!result.ready) await pollUntilReady(cachedExcerptUrl)
  return cachedExcerptUrl
}

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
  hasSource: () => !!props.sourceKey,
  cachedUrl: () => cachedExcerptUrl,
  resolveUrl: resolveExcerptUrl,
  logLabel: "focus-player",
})
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
</style>
