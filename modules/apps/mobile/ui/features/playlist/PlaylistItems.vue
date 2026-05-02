<template>
  <template v-for="row in rows" :key="row.id">
    <WithDeleteAction @delete="emit('delete', row.id)">
      <TrackListItem
        :track-id="row.id"
        :title="row.title"
        :author="row.author"
        :location="row.location"
        :references="row.references"
        :tags="row.tags"
        :date="row.date"
        @select="emit('click', row.id)"
      >
        <template #state>
          <PlaylistStateIndicator :state="row.state" :progress="row.progressPct" />
        </template>
      </TrackListItem>
    </WithDeleteAction>
  </template>
</template>

<script setup lang="ts">
import { WithDeleteAction } from "@ui/primitives/index.js"
import { TrackListItem, type UiTrackRow } from "@ui/components/tracks/list/index.js"
import PlaylistStateIndicator from "./PlaylistStateIndicator.vue"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  rows: readonly UiTrackRow[]
}>()

const emit = defineEmits<{
  click: [trackId: string]
  delete: [trackId: string]
}>()
</script>
