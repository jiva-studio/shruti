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
      v-else-if="trackState.downloadProgress !== undefined && trackState.downloadProgress !== 100"
      slot="end"
      key="downloadProgress"
      color="primary"
      :value="trackState.downloadProgress || 0"
    />
    <RadialIndicator
      v-else-if="playlistItemState.progress !== undefined"
      slot="end"
      key="playbackProgress"
      color="medium"
      :value="playlistItemState.progress || 0"
    />
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type StateIcon, useTracksStateStore, RadialIndicator, IconIndicator } from '@blocks/app.tracks.state'
import { usePlaylistStore } from '@blocks/app.playlist'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  trackId: string
  playlistItemId: string
}>()

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const trackStateStore = useTracksStateStore()
const playlistStore = usePlaylistStore()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const trackState = computed(() => trackStateStore.getState(props.trackId))
const playlistItemState = computed(() => playlistStore.getState(props.playlistItemId))

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const icon = computed<StateIcon>((): StateIcon => {
  let state: StateIcon = 'none'
  
  if (
    playlistItemState.value.progress !== undefined && 
    playlistItemState.value.progress >= 100
  ) { state = 'completed' }
  
  if (
    trackState.value.downloadProgress !== undefined && 
    trackState.value.downloadProgress < 100
  ) { state = 'none'}

  if (trackState.value.isFailed) { state = 'failed' }
  
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
