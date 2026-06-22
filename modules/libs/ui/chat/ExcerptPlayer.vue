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
    <div ref="waveformEl" class="waveform" aria-hidden="true" @click="emit('seek', $event)">
      <span
        v-for="(h, i) in peaks"
        :key="i"
        class="bar"
        :class="{ 'is-played': i / peaks.length < progressFraction }"
        :style="{ height: h + '%' }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useTemplateRef } from "vue"

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
const waveformEl = useTemplateRef<HTMLDivElement>("waveformEl")
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
  width: 14px;
  height: 14px;
}

.waveform {
  flex: 1;
  height: 24px;
  display: flex;
  align-items: center;
  /* `space-between` spreads the bars across the full container width:
     the bar count is chosen from the measured width (see
     useResponsiveBarCount) so the leftover space divides into a small,
     constant gap rather than a single trailing gap on the right. Drops
     the explicit `gap` for the same reason. */
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
  background: rgba(var(--ion-color-medium-rgb), 0.35);
  border-radius: 2px;
  /* `background-color` eases over ~300ms so each bar visibly fades from
   * the faint unplayed tint to the solid played colour as the playhead
   * crosses it, trailing the progress edge rather than snapping.
   * `height` transitions so the swap from the random placeholder peaks
   * to the real decoded peaks reads as a wave settling into shape rather
   * than a hard jump. At a given width the bar count is stable, so Vue
   * updates inline styles in place and CSS handles the tween. */
  transition:
    background-color 300ms ease,
    height 350ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.bar.is-played {
  background: var(--ion-color-medium);
}
</style>
