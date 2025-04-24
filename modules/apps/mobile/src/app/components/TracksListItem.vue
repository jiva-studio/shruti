<template>
  <IonItem
    :disabled="!enabled"
    @click="onItemClicked"
  >
    <IonIcon
      v-if="statusIcon.icon"
      slot="end"
      aria-hidden="true"
      :icon="statusIcon.icon"
      :color="statusIcon.color"
    />
    <IonLabel class="ion-text-nowrap">
      <h3 class="title-block">
        <span class="title">{{ title }}</span> 
        <span class="reference">{{ references[0] }}</span>
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
import { closeCircleOutline, syncOutline, checkmarkCircleOutline } from 'ionicons/icons'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */
export type TracksListItemStatus =
  | 'none'
  | 'loading'
  | 'failed'
  | 'added'

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
  'none':     { icon: undefined,              color: undefined },
  'loading':  { icon: syncOutline,            color: 'medium' },
  'failed':   { icon: closeCircleOutline,     color: 'danger' },
  'added':    { icon: checkmarkCircleOutline, color: 'primary' }
}
const statusIcon = computed(
  () => statusIconMaps[props.status]
)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */
function onItemClicked() {
  emit('click')
}
</script>

<style scoped>
.title-block {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 5px;
}

.title {
  text-overflow: ellipsis;
  overflow: hidden;
}

.reference {
  background-color: var(--ion-color-dark);
  font-weight: bold;
  color: var(--ion-color-light);
  border-radius: 5px;
  padding: 0px 5px;
  font-size: 0.8em;
}
</style>