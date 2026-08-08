<template>
  <template v-for="(item, index) in items" :key="itemKey(item)">
    <template v-if="item.kind === 'track'">
      <PlaylistRow
        :row="item.row"
        @click="emit('click', $event)"
        @delete="emit('delete', $event)"
      />
      <RowDivider v-if="items[index + 1]?.kind === 'track'" />
    </template>
    <div v-else class="collection-group">
      <TrackListItem
        class="group-header"
        :track-id="item.id"
        :title="item.name"
        :author="item.author"
        :references="EMPTY"
        :tags="EMPTY"
        :config="GROUP_HEADER_META"
      >
        <template #state>
          <RadialIndicator slot="end" :value="groupProgress(item.rows)" color="medium" />
        </template>
      </TrackListItem>
      <!-- Rows carry their place in the source collection, resolved from the
           catalog by usePlaylistGroups. Not counted here on purpose: a group is
           a run of consecutive queue rows, so counting them would renumber the
           rest as soon as one is removed. -->
      <template v-for="row in item.rows" :key="row.id">
        <RowDivider />
        <PlaylistRow :row="row" @click="emit('click', $event)" @delete="emit('delete', $event)" />
      </template>
    </div>
  </template>
</template>

<script setup lang="ts">
import RadialIndicator from "@ui/components/tracks/state/RadialIndicator.vue"
import {
  TrackListItem,
  type TrackMetaConfig,
  type UiTrackRow,
} from "@ui/components/tracks/list/index.js"
import RowDivider from "@ui/components/RowDivider.vue"
import PlaylistRow from "./PlaylistRow.vue"
import type { PlaylistRenderItem } from "./types.js"

/**
 * Renders the Home playlist as a mix of standalone track rows and collection
 * groups. A group is delimited by top/bottom border lines (always expanded —
 * no collapse) and a header built from the SAME TrackListItem as a track row,
 * for identical type, spacing and background — only the orange title and the
 * overall-progress ring mark it as the collection. Grouping is derived upstream
 * (usePlaylistGroups); this is presentation-only.
 */
defineProps<{
  items: readonly PlaylistRenderItem[]
}>()

const emit = defineEmits<{
  click: [trackId: string]
  delete: [trackId: string]
}>()

// Stable empty arrays for the header's (unused) reference/tag chip props.
const EMPTY: readonly string[] = []

// A collection group header always shows its author as the subtitle, regardless
// of the user's track-metadata settings — it's the only meta a group has.
const GROUP_HEADER_META: TrackMetaConfig = {
  top: null,
  bottom: [{ field: "author", enabled: true }],
}

/**
 * Overall listening progress (0–100) across a group's lectures: a completed
 * track counts as 100, an in-progress one as its playback %, anything not
 * started as 0. Averaged over the group.
 */
function groupProgress(rows: readonly UiTrackRow[]): number {
  if (rows.length === 0) return 0
  let sum = 0
  for (const r of rows) {
    if (r.state === "completed") sum += 100
    else if (r.state === "playing" || r.state === "queued") sum += r.progressPct
  }
  return Math.round(sum / rows.length)
}

function itemKey(item: PlaylistRenderItem): string {
  return item.kind === "track" ? `t:${item.row.id}` : `g:${item.id}:${item.rows[0]?.id ?? ""}`
}
</script>

<style scoped>
/* One background for the whole collection (header + its tracks): the soft tan
   --ion-color-light. The ring track is the slightly darker --ion-color-light-shade
   (set globally in RadialIndicator), so rings stay visible on this band and look
   identical everywhere. The shared --collection-bg cascades to the grouped rows. */
.collection-group {
  --collection-bg: color-mix(in srgb, var(--ion-color-light) 70%, var(--ion-background-color));
  background: var(--collection-bg);
  /* Faint warm edge lines so the band's start/end stay visible even though the
     fill is muted. */
  border-top: 1px solid rgba(var(--ion-color-primary-rgb), 0.18);
  border-bottom: 1px solid rgba(var(--ion-color-primary-rgb), 0.18);
}

/* Header shares the band background (its IonItem is transparent) and the
   track-row typography; only the orange title marks it as the collection. */
.group-header {
  --ion-item-background: transparent;
  --background: transparent;
}

.group-header :deep(.title) {
  color: var(--ion-color-primary);
  font-weight: 600;
}

/* Grouped track rows take the same band background. */
.collection-group :deep(.playlist-row) {
  background-color: var(--collection-bg);
}
.collection-group :deep(.playlist-row ion-item.track) {
  --ion-item-background: var(--collection-bg);
  --background: var(--collection-bg);
}
</style>
