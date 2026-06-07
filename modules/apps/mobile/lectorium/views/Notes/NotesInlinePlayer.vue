<template>
  <div ref="rootEl" class="notes-inline-player">
    <button
      type="button"
      class="play-btn"
      :aria-label="isPlaying ? 'Pause' : 'Play'"
      :disabled="isPreparing"
      @click="onToggle"
    >
      <IonSpinner v-if="isPreparing" name="crescent" class="play-btn-spinner" />
      <IconPlayerPauseFilled v-else-if="isPlaying" :size="16" />
      <IconPlayerPlayFilled v-else :size="16" />
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
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onMetadata"
    />
  </div>
</template>

<script setup lang="ts">
import { useTemplateRef } from "vue"
import { IonSpinner } from "@ionic/vue"
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { useExcerptAudioPlayer } from "@lectorium/composables/useExcerptAudioPlayer.js"
import { useExcerptWaveform, type ExcerptRef } from "./useExcerptWaveform.js"

interface NoteAudioRef extends ExcerptRef {
  readonly trackId: string
}

const props = defineProps<{ note: NoteAudioRef }>()

const rootEl = useTemplateRef<HTMLDivElement>("rootEl")
const waveformEl = useTemplateRef<HTMLDivElement>("waveformEl")

const { peaks, cachedUrl, resolveExcerptUrl } = useExcerptWaveform({
  // Getter form: `props.note` is rebuilt each render (inline literal in
  // NotesView) and its `sourceKey` is empty until tracks finish loading.
  // Passing the value directly would snapshot that empty key and `cut()`
  // would fail with `400 source_key required`.
  ref: () => props.note,
  rootEl,
  waveformEl,
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
} = useExcerptAudioPlayer({
  hasSource: () => !!props.note.sourceKey,
  cachedUrl,
  resolveUrl: resolveExcerptUrl,
  logLabel: "notes-inline-player",
})
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
