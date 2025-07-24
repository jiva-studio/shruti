<template>
  <Transition
    name="fade"
    mode="out-in"
  >
    <IconIndicator
      v-if="icon !== 'none'"
      slot="end"
      key="icon"
      :icon="icon"
    />
    <RadialIndicator
      v-else-if="state.downloadProgress !== undefined && state.downloadProgress !== 100"
      slot="end"
      key="downloadProgress"
      color="primary"
      :value="state.downloadProgress || 0"
    />
    <RadialIndicator
      v-else-if="state.playbackProgress !== undefined"
      slot="end"
      key="playbackProgress"
      color="medium"
      :value="state.playbackProgress || 0"
    />
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type StateIcon, useTracksStateStore, RadialIndicator, IconIndicator } from '@blocks/app.tracks.state'

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
const state = computed(() => trackStateStore.getState(props.trackId))

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const icon = computed<StateIcon>((): StateIcon => {
  const trackState = trackStateStore.getState(props.trackId)
  let state: StateIcon = 'none'
  if (trackState.playbackProgress && trackState.playbackProgress >= 100) { state = 'completed' }
  if (trackState.isFailed)    { state = 'failed' }
  return state
})
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
