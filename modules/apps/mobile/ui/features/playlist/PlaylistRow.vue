<script setup lang="ts">
import { WithDeleteAction } from "@ui/primitives/index.js"
import { TrackListItem, type UiTrackRow } from "@ui/components/tracks/list/index.js"
import { TrackStateIndicator } from "@ui/components/tracks/state/index.js"
import { usePlaybackRowState } from "./usePlaybackRowState.js"
import type { UiPlaybackProgress } from "./types.js"

/**
 * One playlist track row (swipe-to-delete + state indicator). The same leaf
 * renders both flat rows and the rows nested inside a collection group's
 * accordion.
 *
 * The row itself carries no live playback position — it comes from the
 * `playback` overlay and is applied here, per row, so a position tick
 * re-renders only the row the player is on.
 */
const props = defineProps<{
  row: UiTrackRow
  playback?: UiPlaybackProgress
}>()

const emit = defineEmits<{
  click: [trackId: string]
  delete: [trackId: string]
}>()

const { state, progressPct } = usePlaybackRowState(
  () => props.row,
  () => props.playback
)

// A downloading row is non-interactive for tap (you can't open a file that
// isn't on disk yet), but swipe-to-delete must stay live so the user can
// cancel the download. The tap is guarded here because `pointer-events: none`
// on the wrapper would also kill the swipe.
// Archiving the row then cancels the in-flight transfer via the download store.
function onTap(): void {
  if (!props.row.disabled) emit("click", props.row.id)
}
</script>

<template>
  <div :class="['playlist-row', { 'is-disabled': row.disabled, 'is-dimmed': row.dimmed }]">
    <WithDeleteAction @delete="emit('delete', row.id)">
      <TrackListItem
        :track-id="row.id"
        :title="row.title"
        :position="row.position"
        :author="row.author"
        :location="row.location"
        :references="row.references"
        :tags="row.tags"
        :date="row.date"
        :duration="row.duration"
        @select="onTap"
      >
        <template #state>
          <TrackStateIndicator :state="state" :progress="progressPct" />
        </template>
      </TrackListItem>
    </WithDeleteAction>
  </div>
</template>

<style scoped>
/* Disabled / dimmed visuals sit on the outermost wrapper, outside
   WithDeleteAction (IonItemSliding) — Ionic Stencil components reparent
   slotted content into shadow DOM, where opacity/pointer-events on inner
   wrappers don't hold. A regular <div> at the top level isn't touched by Ionic.

   `is-dimmed` is opacity-only (failed downloads stay tappable to retry).
   `is-disabled` marks a downloading row: its tap is suppressed in JS (onTap)
   so the file can't be opened before it's on disk, but the swipe-to-delete
   stays live so the user can cancel the download. The dim is scoped to
   <ion-label> so the state indicator slot stays vivid. */
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
</style>
