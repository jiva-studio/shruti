<template>
  <svg
    class="kit-heatmap"
    :viewBox="`0 0 ${width} ${height}`"
    :width="width"
    :height="height"
    preserveAspectRatio="xMinYMin meet"
    role="img"
  >
    <rect
      v-for="(cell, i) in cells"
      :key="i"
      :x="xOf(i)"
      :y="yOf(i)"
      :width="cellSize"
      :height="cellSize"
      :rx="radius"
      :ry="radius"
      :fill="cell.fill"
      :stroke="cell.today ? 'var(--ion-color-primary)' : 'none'"
      :stroke-width="cell.today ? strokeWidth : 0"
      paint-order="stroke"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed } from "vue"
import type { HeatmapCell } from "./heatmap.types.js"

/**
 * Generic SVG heatmap grid. Domain-agnostic: it only lays cells out column by
 * column (`rows` per column, default 7 = days of week) and paints each cell the
 * `fill` the caller resolved. No intensity/colour logic and no domain data —
 * those stay in the app, which maps its own metrics → fills/tokens.
 */
const props = withDefaults(
  defineProps<{
    cells: readonly HeatmapCell[]
    rows?: number
    cellSize?: number
    gap?: number
    radius?: number
    strokeWidth?: number
  }>(),
  { rows: 7, cellSize: 12, gap: 3, radius: 2, strokeWidth: 1.5 }
)

const cols = computed(() => Math.max(1, Math.ceil(props.cells.length / props.rows)))
const step = computed(() => props.cellSize + props.gap)
const width = computed(() => Math.max(0, cols.value * step.value - props.gap))
const height = computed(() => Math.max(0, props.rows * step.value - props.gap))

function xOf(i: number): number {
  return Math.floor(i / props.rows) * step.value
}
function yOf(i: number): number {
  return (i % props.rows) * step.value
}
</script>

<style scoped>
.kit-heatmap {
  display: block;
  width: 100%;
  height: auto;
  /* The today cell's stroke is centred on the edge and extends ~strokeWidth/2
     outside the grid; let it paint past the svg box instead of being clipped. */
  overflow: visible;
}
</style>
