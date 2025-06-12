<template>
  <StateIndicator
    :state="state"
    :progress="trackStateStore.getState(trackId).downloadProgress"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useTrackStateStore } from '../composables/useTrackStateStore'
import { default as StateIndicator, type State } from './StateIndicator.vue'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  trackId: string
  ignoreStates?: string[]
}>()

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const trackStateStore = useTrackStateStore()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const state = computed<State>((): State => {
  const trackState = trackStateStore.getState(props.trackId)
  
  let state: State = 'none'
  if (trackState.inPlaylist)  { state = 'added' }
  if (trackState.isCompleted) { state = 'completed' }
  if (trackState.isFailed)    { state = 'failed' }
  if (props.ignoreStates && props.ignoreStates.includes(state)) {
    return 'none'
  }
  return state
})
</script>
