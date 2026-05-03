<template>
  <svg class="activity-heatmap" :viewBox="viewBox" preserveAspectRatio="xMinYMin meet">
    <rect
      v-for="(day, i) in days"
      :key="i"
      :x="Math.floor(i / rowCount) * STEP"
      :y="(i % rowCount) * STEP"
      :width="SQUARE_SIZE"
      :height="SQUARE_SIZE"
      :rx="2"
      :ry="2"
      :style="{ fill: fillColor(day) }"
      :stroke="day.isToday ? 'var(--ion-color-primary, #cc7a3d)' : 'none'"
      :stroke-width="day.isToday ? 2 : 0"
      paint-order="stroke"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed } from "vue"
import type { ActivityHeatmapDay, ActivityHeatmapProps } from "./ActivityHeatmap.types.js"

const SQUARE_SIZE = 10
const GAP = 2
const STEP = SQUARE_SIZE + GAP

// SVG's `fill` attribute does not accept `var(--x)`; we bind it via
// `style` instead so CSSOM resolves the variable at paint time and
// dark-mode swaps happen automatically.
const EMPTY = "var(--heatmap-empty)"
const LISTENED_COLORS = [
  EMPTY,
  "var(--heatmap-listened-1)",
  "var(--heatmap-listened-2)",
  "var(--heatmap-listened-3)",
  "var(--heatmap-listened-4)",
] as const

// Fixed thresholds in seconds. Stable across renders (unlike a max-in-
// window scale which would flicker as new data arrives) and aligned
// with how a user perceives a "lot" of listening:
//   < 15m  → tier 1
//   < 60m  → tier 2
//   < 2h   → tier 3
//   ≥ 2h   → tier 4
const T1 = 15 * 60
const T2 = 60 * 60
const T3 = 120 * 60

const props = withDefaults(defineProps<ActivityHeatmapProps>(), { rows: 7 })

const rowCount = computed(() => Math.max(1, props.rows))
const columns = computed(() => Math.ceil(props.days.length / rowCount.value))
const viewBox = computed(() => `0 0 ${columns.value * STEP - GAP} ${rowCount.value * STEP - GAP}`)

function intensityLevel(seconds: number): number {
  if (seconds <= 0) return 0
  if (seconds < T1) return 1
  if (seconds < T2) return 2
  if (seconds < T3) return 3
  return 4
}

function fillColor(day: ActivityHeatmapDay): string {
  return LISTENED_COLORS[intensityLevel(day.listenedSeconds)]
}
</script>

<style scoped>
.activity-heatmap {
  width: 100%;
  height: auto;
  display: block;
  overflow: visible;
}
</style>
