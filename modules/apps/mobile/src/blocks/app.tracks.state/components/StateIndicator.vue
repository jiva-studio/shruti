<template>
  <Transition
    name="fade"
    mode="out-in"
  >
    <IconIndicator
      v-if="mode === 'icon'"
      slot="end"
      key="icon"
      :icon="icon"
    />
    <RadialIndicator
      v-else-if="mode === 'progress'"
      slot="end"
      key="progress"
      :value="progressValue || 0"
      :color="progressColor || 'primary'"
    />
  </Transition>
</template>


<script lang="ts" setup>
import { toRefs, ref, watch } from 'vue'
import { default as IconIndicator, type StateIcon } from './IconIndicator.vue'
import RadialIndicator from './RadialIndicator.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  icon: StateIcon,
  progressValue?: number | undefined
  progressColor?: string | undefined
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const { progressValue } = toRefs(props) 
const mode = ref<'none'|'icon'|'progress'>('none')

/* -------------------------------------------------------------------------- */
/*                                    Hooks                                   */
/* -------------------------------------------------------------------------- */

watch(
  (): [StateIcon, number|undefined] => [props.icon, props.progressValue], 
  ([i, p]) => onStateChanged(i, p),
  { immediate: true }
)

/* -------------------------------------------------------------------------- */
/*                                  Handlers                                  */
/* -------------------------------------------------------------------------- */

function onStateChanged(
  state: StateIcon, 
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
