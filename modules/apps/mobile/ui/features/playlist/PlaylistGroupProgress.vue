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
 * completed track counts as 100, an in-progress one as how far it has been
 * heard, anything not started as 0. Averaged over the group.
 *
 * Scored from each row's LISTENING data (`listenedPct`), never from its
 * `state`. State carries the transfer too, and a tap on a finished lecture
 * turns its row "pending" and then "downloading" for the length of the
 * re-download — a ring scored from state read that as "not listened" and a
 * finished 3-lecture collection dropped to 67% on the tap itself (issue
 * #1615). The live overlay can only ever raise the number: replaying part of
 * a completed lecture must not pull the ring below the 100 it earned.
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
    const listened = row.listenedPct ?? (row.state === "completed" ? 100 : 0)
    sum += Math.max(listened, live?.progressPct ?? 0)
  }
  return Math.round(sum / props.rows.length)
})
</script>
