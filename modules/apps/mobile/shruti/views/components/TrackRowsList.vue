<script setup lang="ts">
import { TracksList } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import type { UiTrackRow } from "@ui/components/tracks/list/index.js"

withDefaults(defineProps<{ rows: readonly UiTrackRow[]; flush?: boolean }>(), { flush: false })
const emit = defineEmits<{ select: [trackId: string] }>()
</script>

<template>
  <TracksList :flush="flush" :rows="rows" @select="emit('select', $event)">
    <template #state="{ state, progressPct }">
      <TrackStateIndicator :state="state" :progress="progressPct" />
    </template>
  </TracksList>
</template>
