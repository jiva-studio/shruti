<template>
  <IonItem
    class="track"
    lines="none"
    :disabled="disabled"
    button
    :detail="false"
    @click="$emit('select', trackId)"
  >
    <slot
      name="state"
      :track-id="trackId"
    />

    <IonLabel class="ion-text-nowrap">
      <TrackHeader
        class="info"
        :title="title"
        :references="references"
        :tags="tags"
      />
      <TrackDetails
        class="details"
        :author="author"
        :location="location"
        :date="date"
      />
    </IonLabel>
  </IonItem>
</template>


<script setup lang="ts">
import { IonItem, IonLabel } from '@ionic/vue'
import TrackDetails from './TrackDetails.vue'
import TrackHeader from './TrackHeader.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  trackId: string
  title: string
  references: readonly string[]
  tags: readonly string[]
  author?: string
  location?: string
  date?: string
  disabled?: boolean
}>()

defineEmits<{ select: [trackId: string] }>()
</script>

<style scoped>
.track,
.info,
.details {
  transition: all 1s ease;
}
</style>
