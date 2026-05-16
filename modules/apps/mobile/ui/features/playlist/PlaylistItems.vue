<template>
  <template v-for="row in rows" :key="row.id">
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
/* Disabled / dimmed visuals sit on the outermost wrapper, OUTSIDE
   WithDeleteAction (IonItemSliding) — Ionic Stencil components reparent
   slotted content into shadow DOM, which broke opacity/pointer-events
   on inner wrappers. A regular <div> at the top level isn't touched by
   Ionic.

   `is-dimmed` is opacity-only (failed downloads stay tappable to retry).
   `is-disabled` is the hard non-interactive flag (used while a download
   is in flight). Both can coexist: a downloading row is both dimmed and
   non-interactive.

   Ionic's `<IonItem :disabled>` is intentionally NOT used inside
   TrackListItem — it stacks its own ~0.5 dim on top, making a
   downloading row visibly darker than a failed one. Tap blocking is
   owned by this wrapper's pointer-events:none alone.

   The dim is scoped to <ion-label> only — the state indicator slot
   (red X / spinner / completed check) sits OUTSIDE the label inside
   TrackListItem, so it stays at full opacity and reads as the same
   vivid red on Home as on Search. */
/* IonItemSliding translates the IonItem horizontally to reveal the
   IonItemOptions (trash) underneath. The IonItem is set to a transparent
   background globally (TrackListItem.vue), so on Search/Library the row
   blends with the surrounding list. On the Home playlist, however, the
   transparent IonItem lets the revealed trash icon bleed through the
   row content during the swipe. Force an opaque background only here,
   on the actually-translated layer (the IonItem). The previous
   background-color on `.playlist-row` was a no-op for this — that
   wrapper never moves. */
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
