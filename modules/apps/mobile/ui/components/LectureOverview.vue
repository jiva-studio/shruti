<template>
  <div class="lecture-overview">
    <p v-if="description" class="description">{{ description }}</p>

    <template v-if="chapters.length > 0">
      <h3 class="contents-title">{{ t("transcript.contents") }}</h3>
      <ul class="chapters">
        <li
          v-for="(ch, i) in chapters"
          :key="i"
          class="chapter"
          :class="{ interactive }"
          @click="onChapterTap(ch)"
        >
          <span class="time">{{ formatMs(ch.startMs) }}</span>
          <span class="chapter-title">{{ ch.title }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { TrackOutlineChapter } from "@lib/domain/trackVariant.js"

/**
 * Shared lecture overview: a short description followed by a list of chapters
 * (timecode + title). By default the rows are purely informational; pass
 * `interactive` (the transcript reader does) to make each row tappable — it
 * then emits `seek` with the chapter's start (ms). The bottom sheet leaves it
 * off, so the rows stay static there.
 */
const props = withDefaults(
  defineProps<{
    description: string | null
    chapters: readonly TrackOutlineChapter[]
    interactive?: boolean
  }>(),
  { interactive: false }
)

const emit = defineEmits<{
  /** A chapter row was tapped (only when `interactive`); payload is start ms. */
  seek: [startMs: number]
}>()

const { t } = useI18n()

function onChapterTap(ch: TrackOutlineChapter): void {
  if (props.interactive) emit("seek", ch.startMs)
}

// Zero-padded mm:ss (h:mm:ss past an hour) so the column lines up:
// 00:00 / 04:28 / 16:07 / 1:02:03.
function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, "0")
  const ss = String(s).padStart(2, "0")
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
</script>

<style scoped>
.lecture-overview {
  display: flex;
  flex-direction: column;
}

.description {
  margin: 0 0 16px;
  font-size: 15px;
  line-height: 1.5;
  color: var(--ion-text-color, #222);
}

.contents-title {
  margin: 0 0 4px;
  font-size: 13px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ion-color-medium, #777);
}

.chapters {
  list-style: none;
  margin: 0;
  padding: 0;
  padding-inline-start: 0;
}

.chapter {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 4px 0;
}

.chapter.interactive {
  cursor: pointer;
}

.chapter.interactive:active {
  opacity: 0.6;
}

.time {
  flex: none;
  align-self: flex-start;
  padding: 2px 7px;
  border-radius: 6px;
  background: var(--ion-color-step-550, rgba(0, 0, 0, 0.55));
  color: #fff;
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}

.chapter-title {
  flex: 1;
  font-size: 15px;
  line-height: 1.35;
  color: var(--ion-text-color, #222);
}
</style>
