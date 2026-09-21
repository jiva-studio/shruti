<script setup lang="ts">
import { IonItem, IonLabel } from "@ionic/vue"
import TrackStateIndicator from "@ui/components/tracks/state/TrackStateIndicator.vue"
import type { UiTrackState } from "@ui/components/tracks/state/types.js"

defineProps<{
  state: UiTrackState
  progress?: number
  title: string
  description: string
}>()
</script>

<template>
  <IonItem lines="none">
    <div slot="start" class="indicator-slot">
      <TrackStateIndicator :state="state" :progress="progress" />
    </div>
    <IonLabel class="ion-text-wrap">
      <h2>{{ title }}</h2>
      <p>{{ description }}</p>
    </IonLabel>
  </IonItem>
</template>

<style scoped>
.indicator-slot {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  margin-right: 8px;
}
</style>
