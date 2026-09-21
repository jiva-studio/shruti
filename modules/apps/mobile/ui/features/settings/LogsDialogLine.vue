<script setup lang="ts">
import { formatLogTime } from "./formatLogTime.js"

defineProps<{
  ts: number
  level: string
  text: string
}>()
</script>

<template>
  <div class="logs-line" :class="`logs-line--${level}`">
    <div class="logs-line__meta">
      <span class="logs-line__ts">{{ formatLogTime(ts) }}</span>
      <span class="logs-line__lvl">{{ level.toUpperCase() }}</span>
    </div>
    <div class="logs-line__text">{{ text }}</div>
  </div>
</template>

<style scoped>
.logs-line {
  display: flex;
  flex-direction: column;
  padding: 4px 12px;
  border-bottom: 1px solid var(--ion-color-step-100, rgba(0, 0, 0, 0.05));
}

/* Time + level on their own compact line above the message, so the message
   gets the full row width instead of sharing it with a fixed time column. */
.logs-line__meta {
  display: flex;
  gap: 6px;
  font-size: 10px;
  color: var(--ion-color-medium);
}

.logs-line__lvl {
  font-weight: 700;
}

.logs-line__text {
  white-space: pre-wrap;
  word-break: break-word;
}

.logs-line--warn .logs-line__lvl,
.logs-line--warn .logs-line__text {
  color: var(--ion-color-warning-shade, #b26a00);
}

.logs-line--error .logs-line__lvl,
.logs-line--error .logs-line__text {
  color: var(--ion-color-danger, #c0392b);
}

.logs-line--debug {
  opacity: 0.65;
}
</style>
