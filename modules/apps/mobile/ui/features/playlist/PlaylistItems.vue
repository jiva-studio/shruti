<template>
  <template v-for="row in rows" :key="row.id">
    <div :class="['playlist-row', { 'is-disabled': row.disabled }]">
      <WithDeleteAction @delete="emit('delete', row.id)">
        <TrackListItem
          :track-id="row.id"
          :title="row.title"
          :author="row.author"
          :location="row.location"
          :references="row.references"
          :tags="row.tags"
          :date="row.date"
          :disabled="row.disabled"
          @select="emit('click', row.id)"
        >
          <template #state>
            <TrackStateIndicator :state="row.state" :progress="row.progressPct" />
          </template>
        </TrackListItem>
      </WithDeleteAction>
    </div>
  </template>
</template>

<script setup lang="ts">
import { WithDeleteAction } from "@ui/primitives/index.js"
import { TrackListItem, type UiTrackRow } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"

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

<style scoped>
/* Disabled visual sits on the outermost wrapper, OUTSIDE WithDeleteAction
   (IonItemSliding) — Ionic Stencil components reparent slotted content
   into shadow DOM, which broke opacity/pointer-events on inner wrappers.
   A regular <div> at the top level isn't touched by Ionic. */
.playlist-row.is-disabled {
  opacity: 0.65;
  pointer-events: none;
}
</style>
