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
    <div class="waveform" aria-hidden="true" @click="onWaveformClick">
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
import { computed, onBeforeUnmount, ref, useTemplateRef } from "vue"
import { IonSpinner } from "@ionic/vue"
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { useAudioSource } from "@shruti/composables/useAudioOrchestrator.js"
import { useExcerptWaveform, type ExcerptRef } from "./useExcerptWaveform.js"

interface NoteAudioRef extends ExcerptRef {
  readonly trackId: string
}

const props = defineProps<{ note: NoteAudioRef }>()

const audioEl = useTemplateRef<HTMLAudioElement>("audioEl")
const rootEl = useTemplateRef<HTMLDivElement>("rootEl")

const isPlaying = ref(false)
const isPreparing = ref(false)
const positionMs = ref(0)
const durationMs = ref(0)

const { peaks, cachedUrl, resolveExcerptUrl } = useExcerptWaveform({
  // Getter form: `props.note` is rebuilt each render (inline literal in
  // NotesView) and its `sourceKey` is empty until tracks finish loading.
  // Passing the value directly would snapshot that empty key and `cut()`
  // would fail with `400 source_key required`.
  ref: () => props.note,
  rootEl,
})

const progressFraction = computed(() => {
  if (durationMs.value <= 0) return 0
  return Math.min(1, Math.max(0, positionMs.value / durationMs.value))
})

/**
 * Pause this player AND rewind it to the start. When another inline
 * player on the page (or the main lecture, via App.vue) signals that
 * it's about to play, all other inline players should reset to their
 * initial state — leaving them mid-clip / mid-pause means the user sees
 * "multiple players in different positions, none at the beginning."
 *
 * The main lecture player intentionally keeps its position (it registers
 * its own pause-only callback with the orchestrator from the player
 * store) so a tap on a note excerpt doesn't lose the lecture's resume
 * point.
 */
function pauseAndResetSelf(): void {
  const el = audioEl.value
  if (!el) return
  el.pause()
  el.currentTime = 0
  positionMs.value = 0
}

const { claim } = useAudioSource("inline", pauseAndResetSelf)

async function onToggle(): Promise<void> {
  const el = audioEl.value
  if (!el) return
  if (isPlaying.value) {
    el.pause()
    return
  }
  if (!props.note.sourceKey) {
    console.warn("[notes-inline-player] missing source audio path for note", props.note.noteId)
    return
  }
  const knownUrl = cachedUrl()
  if (!knownUrl) {
    isPreparing.value = true
    try {
      el.src = await resolveExcerptUrl()
    } catch (err) {
      isPreparing.value = false
      console.warn("[notes-inline-player] cut failed:", err)
      return
    }
    isPreparing.value = false
  } else if (!el.src) {
    el.src = knownUrl
  }
  claim()
  try {
    await el.play()
  } catch (err) {
    console.warn("[notes-inline-player] play failed:", err)
  }
}

function onWaveformClick(event: MouseEvent): void {
  const el = audioEl.value
  if (!el || durationMs.value <= 0) return
  const target = event.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  el.currentTime = (durationMs.value / 1000) * ratio
}

function onPlay(): void {
  isPlaying.value = true
}

function onPause(): void {
  isPlaying.value = false
}

function onEnded(): void {
  isPlaying.value = false
  positionMs.value = 0
  const el = audioEl.value
  if (el) el.currentTime = 0
}

function onTimeUpdate(): void {
  const el = audioEl.value
  if (!el) return
  positionMs.value = el.currentTime * 1000
}

function onMetadata(): void {
  const el = audioEl.value
  if (!el) return
  durationMs.value = (el.duration || 0) * 1000
}

onBeforeUnmount(() => {
  audioEl.value?.pause()
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
  /* `space-between` makes the 96 fixed-width (2 px) bars span the
     full container width: the leftover horizontal space is divided
     equally between bars instead of collapsing into a single trailing
     gap on the right. Drops the explicit `gap` for the same reason. */
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
   * than a hard jump. Bar count is constant (`BAR_COUNT = 96`), so Vue
   * updates inline styles in place and CSS handles the tween. */
  transition:
    background-color 300ms ease,
    height 350ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.bar.is-played {
  background: var(--ion-color-medium);
}
</style>
