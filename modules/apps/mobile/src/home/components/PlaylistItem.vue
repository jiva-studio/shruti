<template>
  <IonItem @click="onItemClicked">
    <IonIcon
      v-if="PlayListItemStatusIcon.icon"
      aria-hidden="true"
      :icon="PlayListItemStatusIcon.icon"
      :color="PlayListItemStatusIcon.color"
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
import { cloudDownloadOutline } from 'ionicons/icons'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */
export type PlaylistItemStatus =
  | "none"
  | "loading"
  | "playing"

export type PlaylistItemData = {
  trackId: string
  playlistItemId?: string
  title: string
  author: string
  location?: string
  references: string[]
  status: PlaylistItemStatus,
  date: string
}

const props = defineProps<
  PlaylistItemData
>()

const emit = defineEmits<{
  click: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */
type StatusIconMap = {
  [key in PlaylistItemStatus]: { icon?: string, color?: string }
}

const statusIconMaps: StatusIconMap = {
  "none":     { icon: undefined,            color: undefined },
  "loading":  { icon: cloudDownloadOutline, color: 'light' },
  "playing":  { icon: undefined,            color: undefined },
}
const PlayListItemStatusIcon = computed(
  () => statusIconMaps[props.status]
)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */
function onItemClicked() {
  emit('click')
}
</script>