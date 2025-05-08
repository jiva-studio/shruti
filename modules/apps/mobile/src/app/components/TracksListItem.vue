<template>
  <IonItem
    :disabled="!enabled"
    :class="{ 'dimmed': dimmed, 'track': true }"
    @click="onItemClicked"
  >
    <TrackState
      :state="icon"
      :progress="progress"
    />
    <IonLabel class="ion-text-nowrap">
      <TrackInfo
        class="info"
        :title="title"
        :references="references"
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
import { toRefs } from 'vue'
import { IonItem, IonLabel } from '@ionic/vue'
import TrackState from './TrackState.vue'
import TrackDetails from './TrackDetails.vue'
import TrackInfo from './TrackInfo.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type TrackListItemIcon =
  | 'none'
  | 'failed'
  | 'added'
  | 'completed'

export type TracksListItemData = {
  trackId: string
  title: string
  author?: string
  location?: string
  references: string[]
  date: string
  icon: TrackListItemIcon
  dimmed?: boolean
  progress?: number | undefined
}

const props = withDefaults(defineProps<
  TracksListItemData & {
    enabled?: boolean
  }
>(), {
  author: '',
  dimmed: false,
  enabled: true, 
  location: undefined,
  progress: undefined,
})

const emit = defineEmits<{
  click: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */


const { progress } = toRefs(props) 


/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onItemClicked() {
  emit('click')
}
</script>

<style scoped>
.track,
.info,
.details {
  opacity: 1;
  transition: all 1s ease;
}

.dimmed .info,
.dimmed .details {
  opacity: .4;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>