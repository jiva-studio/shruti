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
          @click="emit('pick', ch.startMs)"
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
 * Shared lecture overview: a short description followed by a tappable list of
 * chapters (timecode + title). Reused by the per-track bottom sheet and the
 * transcript reader header. Purely presentational — the parent decides what a
 * chapter tap does (play from there, or seek the open transcript) via `pick`.
 */
defineProps<{
  description: string | null
  chapters: readonly TrackOutlineChapter[]
}>()

const emit = defineEmits<{
  /** A chapter row was tapped; payload is its start position in ms. */
  pick: [startMs: number]
}>()

const { t } = useI18n()

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m)
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`
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
}

.chapter {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 11px 0;
  cursor: pointer;
  border-bottom: 1px solid var(--ion-color-step-100, rgba(0, 0, 0, 0.06));
}

.chapter:last-child {
  border-bottom: none;
}

.chapter:active {
  opacity: 0.6;
}

.time {
  flex: none;
  min-width: 46px;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
  color: var(--ion-color-primary, #3880ff);
}

.chapter-title {
  flex: 1;
  font-size: 15px;
  line-height: 1.35;
  color: var(--ion-text-color, #222);
}
</style>
