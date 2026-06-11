<template>
  <!--
    Media result — YouTube-style: a centered semi-transparent Play overlay on
    the video, a thin progress bar with a scrubber dot along the bottom edge,
    and below it just the title + a chevron that expands the transcript.
    No border. Playback registers with the audio orchestrator (one at a time).
  -->
  <article v-if="payload" class="media-card">
    <div v-if="payload.type === 'video'" class="media-card-stage">
      <video
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

      <button v-if="!playing" class="play-overlay" aria-label="Play" @click.stop="toggle">
        <IconPlayerPlayFilled :size="30" />
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
        :aria-label="playing ? 'Pause' : 'Play'"
        @click="toggle"
      >
        <IconPlayerPauseFilled v-if="playing" :size="18" />
        <IconPlayerPlayFilled v-else :size="18" />
      </button>
      <div class="progress progress--inline" @click="onSeek">
        <div class="progress-track">
          <div class="progress-buffered" :style="{ width: bufferedPct }" />
          <div class="progress-fill" :style="{ width: pct }" />
          <div class="progress-dot" :style="{ left: pct }" />
        </div>
      </div>
      <audio
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
    </div>

    <div class="media-card-body">
      <div class="media-card-meta">
        <span class="media-card-title">{{ payload.title }}</span>
        <button
          v-if="payload.text"
          class="expand-btn"
          :class="{ open: expanded }"
          :aria-label="expanded ? 'Hide transcript' : 'Show transcript'"
          @click="expanded = !expanded"
        >
          <IconChevronDown :size="20" />
        </button>
      </div>

      <div v-if="expanded && payload.text" class="media-card-transcript">
        <span class="media-card-transcript-text">{{ transcriptText }}</span>
        <p v-if="isMt" class="media-card-mt-note">
          <span class="media-card-mt-badge">{{ $t("chat.citationMtBadge") }}</span>
          <button
            type="button"
            class="media-card-mt-toggle"
            @click.stop="showOriginal = !showOriginal"
          >
            {{ showOriginal ? $t("chat.citationViewTranslated") : $t("chat.citationViewOriginal") }}
          </button>
        </p>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from "vue"
import { IconPlayerPlayFilled, IconPlayerPauseFilled, IconChevronDown } from "@tabler/icons-vue"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAudioSource } from "@lectorium/composables/useAudioOrchestrator.js"
import type { MediaPayload } from "@lib/domain/chatMessage.js"

const props = defineProps<{
  /** Server-streamed media payload, read off `message.media[token.mediaId]`.
   *  Optional so a not-yet-resolved id renders nothing instead of throwing. */
  payload?: MediaPayload
}>()

const app = useLectorium()
const mediaEl = ref<HTMLVideoElement | HTMLAudioElement | null>(null)
const playing = ref(false)
const expanded = ref(false)
const progress = ref(0)
const buffered = ref(0)
// Toggle the transcript between the shown text and the original when the
// transcript is a machine translation.
const showOriginal = ref(false)

// True when the transcript is a machine translation with an original to
// flip to.
const isMt = computed<boolean>(() => !!props.payload?.mt && !!props.payload?.textOriginal)
const transcriptText = computed<string>(() => {
  const p = props.payload
  if (!p) return ""
  return showOriginal.value && p.textOriginal ? p.textOriginal : p.text
})

// `payload.url` is a RELATIVE storage path (e.g. `public/media/<id>.mp4`);
// resolve to the active server's CDN URL. Poster = same path, `.jpg`.
const fileUrl = computed(() => (props.payload ? app.storagePublicUrl.get(props.payload.url) : ""))
const posterUrl = computed(() => {
  if (!props.payload) return ""
  return app.storagePublicUrl.get(props.payload.url.replace(/\.[^./]+$/, ".jpg"))
})

const pct = computed(() => `${Math.min(100, Math.max(0, progress.value * 100))}%`)
const bufferedPct = computed(() => `${Math.min(100, Math.max(0, buffered.value * 100))}%`)

function onTimeUpdate(): void {
  const el = mediaEl.value
  progress.value = el && el.duration > 0 ? el.currentTime / el.duration : 0
  onProgress()
}

// Buffered/cached layer — end of the buffered range covering the playhead
// (falls back to the furthest buffered end), as a fraction of duration.
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

function onSeek(event: MouseEvent): void {
  const el = mediaEl.value
  if (!el || !el.duration) return
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  el.currentTime = el.duration * ratio
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

<style scoped>
.media-card {
  display: block;
  margin: 10px 0;
  border-radius: 8px;
  overflow: hidden;
}

/* Video stage — relative so the play overlay + progress bar layer on top. */
.media-card-stage {
  position: relative;
  line-height: 0;
}
.media-card-media {
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
.media-card-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--ion-color-medium-shade);
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

/* Muted machine-translation footnote under the transcript. */
.media-card-mt-note {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--ion-color-medium);
}
.media-card-mt-badge {
  font-style: italic;
}
.media-card-mt-toggle {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ion-color-primary);
  font-size: 11px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
</style>
