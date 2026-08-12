<template>
  <IonList :class="{ flush }">
    <!-- Only when there is something to say. Without a message the row was a
         blank full-height item that reads as content the list does not have. -->
    <IonItem v-if="rows.length === 0 && emptyMessage" lines="none">
      <IonLabel color="medium">{{ emptyMessage }}</IonLabel>
    </IonItem>
    <template v-for="(row, index) in rows" :key="row.id">
      <TrackListItem
        :track-id="row.id"
        :title="row.title"
        :position="row.position"
        :references="row.references"
        :tags="row.tags"
        :author="row.author"
        :location="row.location"
        :date="row.date"
        :duration="row.duration"
        @select="$emit('select', $event)"
      >
        <template #state>
          <slot
            name="state"
            :track-id="row.id"
            :state="row.state"
            :progress-pct="row.progressPct"
          />
        </template>
      </TrackListItem>
      <RowDivider v-if="index < rows.length - 1" />
    </template>
  </IonList>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonList } from "@ionic/vue"
import TrackListItem from "./TrackListItem.vue"
import RowDivider from "@ui/components/RowDivider.vue"
import type { UiTrackRow } from "./types.js"

interface Props {
  rows: readonly UiTrackRow[]
  emptyMessage?: string
  /** Drop the list's own top padding — for a list that sits directly under a
   *  section header, which already owns the gap above the first row. */
  flush?: boolean
}

withDefaults(defineProps<Props>(), { emptyMessage: "", flush: false })
defineEmits<{ select: [trackId: string] }>()
</script>

<style scoped>
/* The section header owns the gap below it; cancel the list's intrinsic top
   (Ionic's own padding plus the first item's) so nothing adds to it. */
ion-list.flush {
  --padding-top: 0;
  padding-top: 0;
  margin-top: -7px;
}
</style>
