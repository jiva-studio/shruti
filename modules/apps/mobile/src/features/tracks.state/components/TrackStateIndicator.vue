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
  const isInPlaylist = trackStateStore.getState(props.trackId).inPlaylist
  const isCompleted = trackStateStore.getState(props.trackId).isCompleted
  
  let state: State = 'none'
  if (isInPlaylist) { state = 'added' }
  if (isCompleted)  { state = 'completed' }
  if (props.ignoreStates && props.ignoreStates.includes(state)) {
    return 'none'
  }
  return state
})
</script>
