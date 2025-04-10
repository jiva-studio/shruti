<template>
  <IonItem @click="onItemClicked">
    <IonIcon
      v-if="playingStatusIcon.icon"
      aria-hidden="true"
      :icon="playingStatusIcon.icon"
      :color="playingStatusIcon.color"
      slot="end"
    />
    <IonLabel class="ion-text-nowrap">
      <h3>
        <b>{{ references[0] }}</b>
        {{ title }}
      </h3>
      <p>
        {{ author }}
        <template v-if="location">
          • {{ location }}
        </template>
        <template v-if="date">
          • {{ date }}
        </template>
      </p>
    </IonLabel>
  </IonItem>
</template>


<script setup lang="ts">
import { computed } from 'vue'
import { IonItem, IonLabel, IonIcon } from '@ionic/vue'
import { headset, cloudDownloadOutline } from 'ionicons/icons'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */
export type PlayingStatus =
  | "none"
  | "loading"
  | "playing"

export interface TrackViewModel {
  trackId: string
  playlistItemId?: string
  title: string
  author: string
  location?: string
  references: string[]
  status: PlayingStatus,
  date: string
}

const props = defineProps<
  TrackViewModel
>()

const emit = defineEmits<{
  click: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */
type StatusIconMap = {
  [key in PlayingStatus]: { icon?: string, color?: string }
}

const statusIconMaps: StatusIconMap = {
  "none":     { icon: undefined,            color: undefined },
  "loading":  { icon: cloudDownloadOutline, color: 'light' },
  "playing":  { icon: undefined,            color: undefined },
}
const playingStatusIcon = computed(
  () => statusIconMaps[props.status]
)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */
function onItemClicked() {
  emit('click')
}
</script>