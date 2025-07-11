<template>
  <Transition
    name="fade"
    mode="out-in"
  >
    <IconIndicator
      v-if="mode === 'icon'"
      slot="end"
      key="icon"
      :state="state"
    />
    <RadialIndicator
      v-else-if="mode === 'progress'"
      slot="end"
      key="progress"
      :progress="progress || 0"
    />
  </Transition>
</template>


<script lang="ts" setup>
import { toRefs, ref, watch } from 'vue'
import IconIndicator from './IconIndicator.vue'
import RadialIndicator from './RadialIndicator.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

export type State = 'none' | 'failed' | 'added' | 'completed'

const props = defineProps<{
  state: State,
  progress?: number | undefined
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

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
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
