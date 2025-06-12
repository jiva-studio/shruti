<template>
  <IonItem
    class="track"
    lines="none"
    :disabled="disabled"
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

export type TrackListItemProps = {
  tags: string[]
  date?: string
  title: string
  author?: string
  location?: string
  disabled?: boolean
  references: string[]
}

export type TrackListItemIdentity = {
  trackId: string
}

defineProps<
  & TrackListItemIdentity
  & TrackListItemProps 
>()

</script>

<style scoped>
.track,
.info,
.details {
  /* opacity: 1; */
  transition: all 1s ease;
}
</style>