<template>
  <StateIndicator
    :icon="icon"
    :progress-value="trackStateStore.getState(trackId).downloadProgress"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useTracksStateStore, StateIndicator, type StateIcon } from '@blocks/app.tracks.state'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  trackId: string
}>()

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const trackStateStore = useTracksStateStore()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const icon = computed<StateIcon>((): StateIcon => {
  const trackState = trackStateStore.getState(props.trackId)
  let state: StateIcon = 'none'
  if (trackState.inPlaylist)  { state = 'added' }
  if (trackState.isCompleted) { state = 'completed' }
  if (trackState.isFailed)    { state = 'failed' }
  return state
})
</script>
