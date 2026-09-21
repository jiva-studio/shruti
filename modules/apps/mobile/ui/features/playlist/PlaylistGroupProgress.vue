<script setup lang="ts">
import { computed } from "vue"
import RadialIndicator from "@ui/components/tracks/state/RadialIndicator.vue"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"
import { groupProgressPct } from "./groupProgress.js"
import type { UiPlaybackProgress } from "./types.js"

/**
 * Its own component so the live position stays out of the list's render: the
 * average is recomputed per tick only for the group that actually holds the
 * playing lecture, and — rounded to a whole percent — it re-renders this ring
 * only when the number moves.
 */
const props = defineProps<{
  rows: readonly UiTrackRow[]
  playback?: UiPlaybackProgress
}>()

const value = computed(() => groupProgressPct(props.rows, props.playback))
</script>

<template>
  <RadialIndicator slot="end" :value="value" color="medium" />
</template>
