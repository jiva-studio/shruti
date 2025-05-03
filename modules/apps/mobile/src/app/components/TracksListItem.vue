<template>
  <IonItem
    :disabled="!enabled"
    :class="{ 'dimmed': dimmed }"
    @click="onItemClicked"
  >
    <!-- Icon and radial progress -->
    <Transition
      name="fade"
      mode="out-in"
    >
      <div
        v-if="iconDisplayMode === 'icon'"
        slot="end"
        key="icon"
      >
        <IonIcon
          aria-hidden="true"
          :icon="statusIcon.icon"
          :color="statusIcon.color"
          class="icon"
        />
      </div>
      <div
        v-else-if="iconDisplayMode === 'progress'"
        slot="end"
        key="progress"
      >
        <RadialProgress
          :stroke-width="4"
          :inner-stroke-width="4"
          :diameter="24"
          :completed-steps="progress"
          :total-steps="100"
          :animate-speed="750"
          start-color="var(--ion-color-primary)"
          stop-color="var(--ion-color-primary)"
          inner-stroke-color="var(--ion-color-light)"
        />
      </div>
    </Transition>
  
    <!-- Track information -->
    <IonLabel class="ion-text-nowrap">
      <h3 class="title-block">
        <span
          v-if="references[0]"
          class="reference"
        >
          {{ references[0] }}
        </span>
        <span
          v-if="references?.length > 1"
          class="reference extra"
        >
          +{{ references.length-1 }}
        </span>
        <span class="title">{{ title }}</span>
      </h3>
      <p class="details">
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
import { computed, toRefs, ref, watch } from 'vue'
import { IonItem, IonLabel, IonIcon } from '@ionic/vue'
import { closeCircle, checkmarkCircle, checkmarkDoneCircle } from 'ionicons/icons'
import RadialProgress from 'vue3-radial-progress'

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
  author: string
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

type StatusIconMap = {
  [key in TrackListItemIcon]: { icon?: string, color?: string }
}

const statusIconMaps: StatusIconMap = {
  'none':      { icon: undefined,           color: undefined },
  'failed':    { icon: closeCircle,         color: 'danger'  },
  'added':     { icon: checkmarkCircle,     color: 'primary' },
  'completed': { icon: checkmarkDoneCircle, color: 'medium' },
}
const statusIcon = computed(
  () => statusIconMaps[props.icon]
)

const { progress } = toRefs(props) 
const iconDisplayMode = ref<string>('none')

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch((): [TrackListItemIcon, number|undefined] => [props.icon, props.progress], ([i, p]) => {
  if (p !== undefined && p < 100) { 
    iconDisplayMode.value = 'progress'
  } else { 
    if (iconDisplayMode.value === 'progress') {
      setTimeout(() => { iconDisplayMode.value = i !== 'none' ? 'icon' : 'none' },  1000)
    } else {
      iconDisplayMode.value = i !== 'none' ? 'icon' : 'none'
    }
  }
}, { immediate: true })

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
  align-items: center;
  gap: 5px;
}

.title {
  text-overflow: ellipsis;
  overflow: hidden;
}

.reference {
  background-color: var(--ion-color-medium);
  font-weight: bold;
  color: var(--ion-color-light);
  border-radius: 5px;
  padding: 0px 5px;
  font-size: 0.8em;
  font-stretch: condensed;
}

.reference.extra {
  font-stretch: condensed;
  opacity: .5;
}

.dimmed .reference.extra {
  font-stretch: condensed;
  opacity: .2;
}

.icon {
  width: 24px;
  height: 24px;
}

.dimmed .title,
.dimmed .reference,
.dimmed .icon,
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