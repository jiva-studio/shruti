<template>
  <RadialIndicator slot="end" :value="value" color="medium" />
</template>

<script setup lang="ts">
import { computed } from "vue"
import RadialIndicator from "@ui/components/tracks/state/RadialIndicator.vue"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import { livePlaybackFor } from "./usePlaybackRowState.js"
import type { UiPlaybackProgress } from "./types.js"

/**
 * Overall listening progress (0–100) across a collection group's lectures: a
 * completed track counts as 100, an in-progress one as its playback %,
 * anything not started as 0. Averaged over the group.
 *
 * Its own component so the live position stays out of the list's render: the
 * average is recomputed per tick only for the group that actually holds the
 * playing lecture, and — rounded to a whole percent — it re-renders this ring
 * only when the number moves.
 */
const props = defineProps<{
  rows: readonly UiTrackRow[]
  playback?: UiPlaybackProgress
}>()

const value = computed(() => {
  if (props.rows.length === 0) return 0
  let sum = 0
  for (const row of props.rows) {
    const live = livePlaybackFor(row, props.playback)
    const state = live?.state ?? row.state
    if (state === "completed") sum += 100
    else if (state === "playing" || state === "queued") sum += live?.progressPct ?? row.progressPct
  }
  return Math.round(sum / props.rows.length)
})
</script>
