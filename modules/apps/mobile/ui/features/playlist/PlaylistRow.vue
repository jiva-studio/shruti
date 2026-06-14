<template>
  <div :class="['playlist-row', { 'is-disabled': row.disabled, 'is-dimmed': row.dimmed }]">
    <WithDeleteAction @delete="emit('delete', row.id)">
      <TrackListItem
        :track-id="row.id"
        :title="row.title"
        :author="row.author"
        :location="row.location"
        :references="row.references"
        :tags="row.tags"
        :date="row.date"
        :duration="row.duration"
        @select="emit('click', row.id)"
      >
        <template #state>
          <TrackStateIndicator :state="row.state" :progress="row.progressPct" />
        </template>
      </TrackListItem>
    </WithDeleteAction>
  </div>
</template>

<script setup lang="ts">
import { WithDeleteAction } from "@ui/primitives/index.js"
import { TrackListItem, type UiTrackRow } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"

/**
 * One playlist track row (swipe-to-delete + state indicator). Extracted from
 * PlaylistItems so the same leaf renders both flat rows and the rows nested
 * inside a collection group's accordion.
 */
defineProps<{
  row: UiTrackRow
}>()

const emit = defineEmits<{
  click: [trackId: string]
  delete: [trackId: string]
}>()
</script>

<style scoped>
/* Disabled / dimmed visuals sit on the outermost wrapper, OUTSIDE
   WithDeleteAction (IonItemSliding) — Ionic Stencil components reparent
   slotted content into shadow DOM, which broke opacity/pointer-events on
   inner wrappers. A regular <div> at the top level isn't touched by Ionic.

   `is-dimmed` is opacity-only (failed downloads stay tappable to retry).
   `is-disabled` is the hard non-interactive flag (used while a download is in
   flight). Both can coexist: a downloading row is both dimmed and
   non-interactive. The dim is scoped to <ion-label> so the state indicator
   slot stays vivid. */
.playlist-row {
  background-color: var(--ion-background-color);
}
.playlist-row :deep(ion-item.track) {
  --ion-item-background: var(--ion-background-color);
  --background: var(--ion-background-color);
}
.playlist-row.is-dimmed :deep(ion-label) {
  opacity: 0.65;
}
.playlist-row.is-disabled {
  pointer-events: none;
}
</style>
