<template>
  <div class="notes-inline-player">
    <button
      type="button"
      class="play-btn"
      :aria-label="isPlaying ? 'Pause' : 'Play'"
      :disabled="isPreparing"
      @click="emit('toggle')"
    >
      <span v-if="isPreparing" class="play-btn-spinner"><slot name="spinner" /></span>
      <svg v-else-if="isPlaying" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" />
        <path d="M17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z" />
      </svg>
    </button>
    <Waveform
      ref="waveformInner"
      :peaks="peaks"
      :progress-fraction="progressFraction"
      @seek="emit('seek', $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, useTemplateRef } from "vue"
import Waveform from "../player/Waveform.vue"

defineProps<{
  /** Bar heights (0–100%) — decoded peaks or a placeholder. Owned by the host. */
  peaks: readonly number[]
  /** Playhead position as a fraction (0–1); bars left of it render as played. */
  progressFraction: number
  /** Playback state — drives the play/pause glyph. Owned by the host. */
  isPlaying: boolean
  /** Buffering — shows the `#spinner` slot and disables the button. */
  isPreparing: boolean
}>()

const emit = defineEmits<{
  toggle: []
  /** Waveform click; the host maps the position to a seek (it owns the
   *  media element + duration). */
  seek: [event: MouseEvent]
}>()

// Exposed so a host can measure the bar container's width (responsive bar
// count) and observe visibility — both pure DOM concerns the host's
// waveform/audio composables drive.
const waveformInner = useTemplateRef<{ waveformEl: HTMLDivElement | null }>("waveformInner")
const waveformEl = computed<HTMLDivElement | null>(() => waveformInner.value?.waveformEl ?? null)
defineExpose({ waveformEl })
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
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
}
.play-btn-spinner :deep(*) {
  width: 100%;
  height: 100%;
}
</style>
