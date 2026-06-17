<template>
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

<script setup lang="ts">
import type { UiOutlineChapter } from "./types.js"

/**
 * The lecture outline: a timecode chip + chapter title per row. Purely
 * presentational. Pass `interactive` to make rows tappable — it then emits
 * `seek` with the chapter's start (ms).
 */
const props = withDefaults(
  defineProps<{
    chapters: readonly UiOutlineChapter[]
    interactive?: boolean
  }>(),
  { interactive: false }
)

const emit = defineEmits<{
  seek: [startMs: number]
}>()

function onChapterTap(ch: UiOutlineChapter): void {
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
.chapters {
  list-style: none;
  margin: 0;
  padding: 0;
  padding-inline-start: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chapter {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}

.chapter.interactive {
  cursor: pointer;
}

.chapter.interactive:active {
  opacity: 0.6;
}

.time {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 8px;
  border-radius: 6px;
  background: rgba(var(--ion-color-primary-rgb), 0.14);
  color: var(--ion-color-primary);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  font-weight: 600;
}

.chapter-title {
  flex: 1;
  font-size: 15px;
  line-height: 22px;
  color: var(--ion-text-color, #222);
}
</style>
