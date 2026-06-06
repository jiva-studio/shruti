<template>
  <Heatmap :cells="cells" :rows="props.rows" :cell-size="10" :gap="2" :stroke-width="2" />
</template>

<script setup lang="ts">
import { computed } from "vue"
import { Heatmap, type HeatmapCell } from "@kit/ui"
import type { ActivityHeatmapDay, ActivityHeatmapProps } from "./ActivityHeatmap.types.js"

// Listening-time intensity (domain) stays here; rendering is delegated to the
// generic @kit/ui/Heatmap. SVG `fill` can't take `var(--x)` directly, so we
// pass the CSS variable as the cell fill and the kit grid binds it via attr —
// CSSOM resolves it at paint time (dark-mode swaps automatically).
const EMPTY = "var(--heatmap-empty)"
const LISTENED_COLORS = [
  EMPTY,
  "var(--heatmap-listened-1)",
  "var(--heatmap-listened-2)",
  "var(--heatmap-listened-3)",
  "var(--heatmap-listened-4)",
] as const

// Fixed thresholds in seconds — stable across renders (a max-in-window scale
// would flicker as data arrives): <15m → t1, <60m → t2, <2h → t3, ≥2h → t4.
const T1 = 15 * 60
const T2 = 60 * 60
const T3 = 120 * 60

const props = withDefaults(defineProps<ActivityHeatmapProps>(), { rows: 7 })

function intensityLevel(seconds: number): number {
  if (seconds <= 0) return 0
  if (seconds < T1) return 1
  if (seconds < T2) return 2
  if (seconds < T3) return 3
  return 4
}

const cells = computed<HeatmapCell[]>(() =>
  props.days.map((day: ActivityHeatmapDay) => ({
    fill: LISTENED_COLORS[intensityLevel(day.listenedSeconds)],
    today: day.isToday,
  }))
)
</script>
