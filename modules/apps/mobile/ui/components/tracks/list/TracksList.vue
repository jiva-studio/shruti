<template>
  <IonList>
    <IonItem v-if="rows.length === 0" lines="none">
      <IonLabel color="medium">{{ emptyMessage }}</IonLabel>
    </IonItem>
    <template v-for="(row, index) in rows" :key="row.id">
      <TrackListItem
        :track-id="row.id"
        :title="row.title"
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
}

withDefaults(defineProps<Props>(), { emptyMessage: "" })
defineEmits<{ select: [trackId: string] }>()
</script>
