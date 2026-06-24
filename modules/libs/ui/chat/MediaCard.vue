<template>
  <!--
    Media result — YouTube-style: a centered semi-transparent Play overlay on
    the video, a thin progress bar with a scrubber dot along the bottom edge,
    and below it just the title + a chevron that expands the transcript.
    No border. The media element + playback (orchestrator, seek, progress)
    are HOST concerns: the container provides the element via `#media` and
    feeds `isPlaying` / `progressFraction` / `bufferedFraction`.
  -->
  <article v-if="payload" class="media-card">
    <div v-if="payload.type === 'video'" class="media-card-stage">
      <slot name="media" />

      <button v-if="!isPlaying" class="play-overlay" aria-label="Play" @click.stop="emit('toggle')">
        <slot name="play-icon" :size="30" />
      </button>

      <div class="progress" @click.stop="onSeek">
        <div class="progress-track">
          <div class="progress-buffered" :style="{ width: bufferedPct }" />
          <div class="progress-fill" :style="{ width: pct }" />
          <div class="progress-dot" :style="{ left: pct }" />
        </div>
      </div>
    </div>

    <!-- Audio fallback: a compact play row (no video stage). -->
    <div v-else class="media-card-audiorow">
      <button
        class="play-overlay play-overlay--inline"
        :aria-label="isPlaying ? 'Pause' : 'Play'"
        @click="emit('toggle')"
      >
        <slot v-if="isPlaying" name="pause-icon" :size="18" />
        <slot v-else name="play-icon" :size="18" />
      </button>
      <div class="progress progress--inline" @click="onSeek">
        <div class="progress-track">
          <div class="progress-buffered" :style="{ width: bufferedPct }" />
          <div class="progress-fill" :style="{ width: pct }" />
          <div class="progress-dot" :style="{ left: pct }" />
        </div>
      </div>
      <slot name="media" />
    </div>

    <div class="media-card-body">
      <div class="media-card-meta">
        <div class="media-card-titles">
          <span class="media-card-title">{{ payload.title }}</span>
          <span v-if="attribution" class="media-card-attribution">{{ attribution }}</span>
        </div>
        <button
          v-if="payload.text"
          class="expand-btn"
          :class="{ open: expanded }"
          :aria-label="expanded ? 'Hide transcript' : 'Show transcript'"
          @click="expanded = !expanded"
        >
          <slot name="expand-icon" :size="20" />
        </button>
      </div>

      <AutoHeight v-if="expanded && payload.text">
        <div class="media-card-transcript">
          <span class="media-card-transcript-text">{{ transcriptText }}</span>
        </div>
      </AutoHeight>
    </div>
  </article>

  <TranslationNotice
    v-if="expanded && isMt"
    :show-original="showOriginal"
    @update:show-original="emit('update:show-original', $event)"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import type { MediaPayload } from "@lib/domain/chatMessage.js"
import TranslationNotice from "./TranslationNotice.vue"
import AutoHeight from "./AutoHeight.vue"

const props = withDefaults(
  defineProps<{
    /** Server-streamed media payload, read off `message.media[token.mediaId]`.
     *  Optional so a not-yet-resolved id renders nothing instead of throwing. */
    payload?: MediaPayload
    /** Playback state — drives the play overlay. Owned by the host. */
    isPlaying?: boolean
    /** Playhead position as a fraction of duration (0–1). Owned by the host. */
    progressFraction?: number
    /** Buffered range covering the playhead as a fraction of duration (0–1). */
    bufferedFraction?: number
    /** Transcript in the active translation (host folds in `showOriginal`). */
    transcriptText?: string
    /** True when the transcript is a machine translation with an original to
     *  flip to — gates the TranslationNotice. Computed by the host. */
    isMt?: boolean
    /** Machine-translation toggle state, owned by the host. */
    showOriginal?: boolean
  }>(),
  {
    payload: undefined,
    isPlaying: false,
    progressFraction: 0,
    bufferedFraction: 0,
    transcriptText: "",
    isMt: false,
    showOriginal: false,
  }
)

const emit = defineEmits<{
  toggle: []
  /** Seek request as a fraction of duration (0–1). The host applies it to
   *  its media element. */
  seek: [fraction: number]
  "update:show-original": [value: boolean]
}>()

const expanded = ref(false)

// Attribution line under the title: "speaker · date" (either part may be
// absent — join only what's present, blank → the line is hidden).
const attribution = computed(() =>
  [props.payload?.speaker, props.payload?.date].filter(Boolean).join(" · ")
)

const pct = computed(() => `${Math.min(100, Math.max(0, props.progressFraction * 100))}%`)
const bufferedPct = computed(() => `${Math.min(100, Math.max(0, props.bufferedFraction * 100))}%`)

function onSeek(event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  emit("seek", ratio)
}
</script>

<style scoped>
.media-card {
  display: block;
  margin: 10px 0;
  border-radius: 4px;
  overflow: hidden;
}

/* Video stage — relative so the play overlay + progress bar layer on top. */
.media-card-stage {
  position: relative;
  line-height: 0;
}
.media-card-stage :deep(.media-card-media) {
  display: block;
  width: 100%;
  max-height: 60vh;
  background: #000;
  cursor: pointer;
  vertical-align: bottom;
}

/* Centered, semi-transparent Play (YouTube-style). */
.play-overlay {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 60px;
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.play-overlay--inline {
  position: static;
  transform: none;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  background: var(--ion-color-medium);
  color: var(--ion-color-medium-contrast);
}

/* Thin progress bar pinned to the bottom edge of the video. */
.progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 14px;
  display: flex;
  align-items: flex-end; /* track hugs the very bottom edge of the video */
  padding: 0;
  cursor: pointer;
}
.progress--inline {
  position: static;
  flex: 1;
  height: 28px;
  padding: 0;
}
.progress-track {
  position: relative;
  flex: 1;
  height: 3px;
  background: rgba(255, 255, 255, 0.35);
}
/* Video: anchor the track pixel-exact to the very bottom edge (flex
 * alignment can leave a sub-pixel sliver under it). */
.media-card-stage .progress-track {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  flex: none;
}
.progress--inline .progress-track {
  background: rgba(var(--ion-color-medium-rgb), 0.3);
}
.progress-buffered {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.5);
}
.progress--inline .progress-buffered {
  background: rgba(var(--ion-color-medium-rgb), 0.5);
}
.progress-fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--ion-color-primary);
}
.progress-dot {
  position: absolute;
  top: 50%;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: var(--ion-color-primary);
  transform: translate(-50%, -50%);
}

.media-card-audiorow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 0;
}

/* Bottom panel — soft tint; the card's overflow + radius round its corners. */
.media-card-body {
  background: rgba(var(--ion-color-primary-rgb), 0.06);
}

/* Meta row: title + transcript toggle. No border. */
.media-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: rgba(var(--ion-color-primary-rgb), 0.08);
}
/* Title (bold) over attribution (lighter), stacked — takes the row's free
 * width so the expand chevron stays pinned to the right. */
.media-card-titles {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.media-card-title {
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ion-color-medium-shade);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.media-card-attribution {
  font-size: 13px;
  font-weight: 400;
  color: var(--ion-color-medium);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.expand-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--ion-color-medium);
  cursor: pointer;
  transition: transform 0.2s ease;
}
.expand-btn.open {
  transform: rotate(180deg);
}

.media-card-transcript {
  padding: 10px 12px 12px;
  line-height: 1.45;
  white-space: pre-wrap;
}
</style>
