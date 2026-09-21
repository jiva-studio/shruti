<script setup lang="ts">
import { computed } from "vue"
import { barHeight, type ChartDay } from "../weeklyDigest.js"

// One rounded bar per day, height proportional to time listened.
const props = defineProps<{ days: readonly ChartDay[]; label: string }>()

const peakSeconds = computed(() =>
  props.days.reduce((max, d) => Math.max(max, d.listenedSeconds), 0)
)

function barStyle(seconds: number): { height: string } {
  return { height: barHeight(seconds, peakSeconds.value) }
}
</script>

<template>
  <div class="digest-chart" :aria-label="label">
    <div v-for="(day, i) in days" :key="i" class="digest-chart-col">
      <div class="digest-chart-track">
        <div
          class="digest-chart-bar"
          :class="{ 'digest-chart-bar--today': day.isToday }"
          :style="barStyle(day.listenedSeconds)"
        />
      </div>
      <div class="digest-chart-label">{{ day.label }}</div>
    </div>
  </div>
</template>

<style scoped>
.digest-chart {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  height: 84px;
}
.digest-chart-col {
  flex: 1 1 0;
  /* Fill the chart's fixed height so the track below is a definite box —
   * without this the column shrinks to its label and the bars' percentage
   * heights resolve against ~0. */
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
}
.digest-chart-track {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}
.digest-chart-bar {
  width: 60%;
  min-height: 2px;
  border-radius: 6px;
  background: rgba(var(--ion-color-primary-rgb), 0.35);
  transition: height 0.2s ease;
}
.digest-chart-bar--today {
  background: var(--ion-color-primary);
}
.digest-chart-label {
  margin-top: 4px;
  font-size: 10px;
  text-transform: uppercase;
  color: var(--ion-color-medium);
}
</style>
