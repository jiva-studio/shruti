<template>
  <IonItem
    :disabled="!enabled"
    @click="onItemClicked"
  >
    <IonIcon
      v-if="PlayListItemStatusIcon.icon"
      slot="end"
      aria-hidden="true"
      :icon="PlayListItemStatusIcon.icon"
      :color="PlayListItemStatusIcon.color"
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
import { closeCircleOutline, syncOutline } from 'ionicons/icons'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */
export type TracksListItemStatus =
  | 'none'
  | 'loading'
  | 'failed'

export type TracksListItemData = {
  trackId: string
  title: string
  author: string
  location?: string
  references: string[]
  status: TracksListItemStatus,
  date: string
}

const props = withDefaults(defineProps<
  TracksListItemData & {
    enabled?: boolean
  }
>(), {
  enabled: true, 
  location: undefined 
})

const emit = defineEmits<{
  click: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */
type StatusIconMap = {
  [key in TracksListItemStatus]: { icon?: string, color?: string }
}

const statusIconMaps: StatusIconMap = {
  'none':     { icon: undefined,          color: undefined },
  'loading':  { icon: syncOutline,        color: 'medium' },
  'failed':   { icon: closeCircleOutline, color: 'danger' },
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