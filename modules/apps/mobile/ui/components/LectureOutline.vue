<template>
  <ul class="chapters">
    <li
      v-for="(ch, i) in chapters"
      :key="i"
      class="chapter"
      :class="{ interactive }"
      @click="onChapterTap(ch)"
    >
      <span class="time">{{ stamp(ch.startMs) }}</span>
      <span class="chapter-title">{{ ch.title }}</span>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { computed } from "vue"
import type { UiOutlineChapter } from "./types.js"

/**
 * The lecture outline: a timecode chip + chapter title per row. Purely
 * presentational. Pass `interactive` to make rows tappable — it then emits
 * `seek` with the chapter's start (ms).
 *
 * `granularity` is the smallest unit worth reading here: an outline is scanned,
 * so minutes are enough; the transcript, where a stamp is a place to jump to,
 * keeps seconds.
 */
const props = withDefaults(
  defineProps<{
    chapters: readonly UiOutlineChapter[]
    interactive?: boolean
    granularity?: "second" | "minute"
  }>(),
  { interactive: false, granularity: "second" }
)

const emit = defineEmits<{
  seek: [startMs: number]
}>()

function onChapterTap(ch: UiOutlineChapter): void {
  if (props.interactive) emit("seek", ch.startMs)
}

// Every stamp in one outline carries the same units, decided by its longest
// chapter — otherwise the column is ragged, one row reading 50:43 and the next
// 1:05:20.
const withHours = computed(
  () => props.granularity === "minute" || props.chapters.some((c) => c.startMs >= 3_600_000)
)

function stamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0")
  const ss = String(total % 60).padStart(2, "0")
  const hh = withHours.value ? `${h}:` : ""
  return props.granularity === "minute" ? `${hh}${mm}` : `${hh}${mm}:${ss}`
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
  justify-content: center;
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
