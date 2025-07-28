<template>
  <Transition
    name="fade"
    mode="out-in"
  >
    <IconIndicator
      v-if="state.mode === 'icon'"
      slot="end"
      key="icon"
      :icon="state.icon"
    />
    <RadialIndicator
      v-else-if="state.mode === 'downloading'"
      slot="end"
      key="downloadProgress"
      color="primary"
      :value="state.downloadProgress || 0"
    />
    <RadialIndicator
      v-else-if="state.mode === 'progress'"
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

const state = computed(() => {
  const track = trackStateStore.getState(props.trackId)
  const item = playlistStore.getState(props.playlistItemId)

  // ICON
  let icon: StateIcon = 'none'
  if (track.isFailed) {
    icon = 'failed'
  } else if (item.progress !== undefined && item.progress >= 100) {
    icon = 'completed'
  }

  // MODE
  let mode: 'downloading' | 'icon' | 'progress' | undefined = undefined
  if (track.downloadProgress !== undefined && track.downloadProgress !== 100) {
    mode = 'downloading'
  } else if (track.isFailed || (item.progress !== undefined && item.progress === 100)) {
    mode = 'icon'
  } else if (item.progress !== undefined) {
    mode = 'progress'
  }

  return { 
    mode, icon, 
    downloadProgress: track.downloadProgress, 
    playbackProgress: item.progress 
  }
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
