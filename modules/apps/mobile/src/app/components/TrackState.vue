<template>
  <Transition
    name="fade"
    mode="out-in"
  >
    <div
      v-if="mode === 'icon'"
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
      v-else-if="mode === 'progress'"
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
</template>


<script lang="ts" setup>
import { computed, toRefs, ref, watch } from 'vue'
import { IonIcon } from '@ionic/vue'
import { closeCircle, checkmarkCircle, checkmarkDoneCircle } from 'ionicons/icons'
import RadialProgress from 'vue3-radial-progress'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

type State = 'none' | 'failed' | 'added' | 'completed'

const props = defineProps<{
  state: State,
  progress?: number | undefined
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

type StateIconMap = {
  [key in State]: { icon?: string, color?: string }
}

const stateIconMaps: StateIconMap = {
  'none':      { icon: undefined,           color: undefined },
  'failed':    { icon: closeCircle,         color: 'danger'  },
  'added':     { icon: checkmarkCircle,     color: 'primary' },
  'completed': { icon: checkmarkDoneCircle, color: 'medium' },
}
const statusIcon = computed(
  () => stateIconMaps[props.state]
)

const { progress } = toRefs(props) 
const mode = ref<'none'|'icon'|'progress'>('none')

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(
  (): [State, number|undefined] => [props.state, props.progress], 
  ([i, p]) => onStateChanged(i, p),
  { immediate: true }
)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onStateChanged(
  state: State, 
  progress: number|undefined
) {
  if (progress !== undefined && progress < 100) { 
    mode.value = 'progress'
  } else { 
    if (mode.value === 'progress') {
      setTimeout(() => { mode.value = state !== 'none' ? 'icon' : 'none' },  1000)
    } else {
      mode.value = state !== 'none' ? 'icon' : 'none'
    }
  }
}
</script>


<style scoped>
.icon {
  width: 24px;
  height: 24px;
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
