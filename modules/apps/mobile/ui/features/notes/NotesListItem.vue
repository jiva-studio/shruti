<template>
  <IonItem lines="none" class="note" button :detail="false" @click="$emit('click', noteId)">
    <div class="body">
      <HighlightText :text="text" :lang="language" />

      <div v-if="hasHeader" class="header">
        <span v-if="authorName" class="author">{{ authorName }}</span>
        <span v-if="trackTitle" class="title">{{ trackTitle }}</span>
      </div>

      <div v-if="hasMeta" class="meta">
        <span v-if="trackDate">{{ trackDate }}</span>
        <span v-if="locationName">{{ locationName }}</span>
        <span v-if="reference">{{ reference }}</span>
        <span class="time">{{ timeRange }}</span>
      </div>
    </div>
  </IonItem>
</template>

<script lang="ts" setup>
import { computed } from "vue"
import { IonItem } from "@ionic/vue"
import { HighlightText } from "@ui/primitives/index.js"

const props = defineProps<{
  noteId: string
  text: string
  language?: string
  authorName?: string
  trackTitle?: string
  trackDate?: string
  locationName?: string
  reference?: string
  timeStart?: number
  timeEnd?: number
}>()

defineEmits<{ click: [noteId: string] }>()

const hasHeader = computed(() => Boolean(props.authorName || props.trackTitle))

const timeRange = computed<string>(() => formatTimeRange(props.timeStart, props.timeEnd))

const hasMeta = computed(
  () =>
    Boolean(props.trackDate) ||
    Boolean(props.locationName) ||
    Boolean(props.reference) ||
    timeRange.value.length > 0
)

function formatTimeRange(startSec?: number, endSec?: number): string {
  if (typeof startSec !== "number" || !Number.isFinite(startSec) || startSec < 0) return ""
  const start = mmss(startSec)
  if (typeof endSec !== "number" || !Number.isFinite(endSec) || endSec <= startSec) return start
  return `${start}–${mmss(endSec)}`
}

function mmss(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number) => n.toString().padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
</script>

<style scoped>
.note {
  border-left: 5px solid;
  border-color: var(--ion-color-primary-tint);
  margin: 1rem 0rem;

  text-align: justify;
  text-justify: inter-word;
  hyphens: auto;
  -moz-hyphens: auto;
}

.body {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.25rem 0;
  width: 100%;
}

.header {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--ion-color-medium);
  text-align: left;
}

.header .author {
  font-weight: 600;
}

.header .title {
  font-style: italic;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.6rem;
  font-size: 0.75rem;
  color: var(--ion-color-medium);
  text-align: left;
}

.meta .time {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
</style>
