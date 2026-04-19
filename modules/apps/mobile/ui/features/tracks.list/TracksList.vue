<template>
  <IonList>
    <IonItem v-if="rows.length === 0" lines="none">
      <IonLabel color="medium">{{ emptyMessage }}</IonLabel>
    </IonItem>
    <IonItem
      v-for="row in rows"
      :key="row.id"
      button
      :detail="true"
      @click="$emit('select', row.id)"
    >
      <IonLabel>
        <h3>{{ row.title }}</h3>
        <p>
          <span>{{ row.authorName }}</span>
          <span v-if="row.date"> · {{ row.date }}</span>
          <span v-if="row.reference"> · {{ row.reference }}</span>
        </p>
      </IonLabel>
      <IonNote v-if="row.durationMs" slot="end">{{ formatDuration(row.durationMs) }}</IonNote>
    </IonItem>
  </IonList>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonList, IonNote } from "@ionic/vue"
import type { UiTrackRow } from "./types.js"

interface Props {
  rows: readonly UiTrackRow[]
  emptyMessage?: string
}

withDefaults(defineProps<Props>(), { emptyMessage: "No tracks yet." })
defineEmits<{ select: [trackId: string] }>()

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return `${m}:${String(s).padStart(2, "0")}`
}
</script>
