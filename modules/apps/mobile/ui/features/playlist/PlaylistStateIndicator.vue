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
      v-else-if="mode === 'downloading'"
      slot="end"
      key="downloadProgress"
      color="primary"
      :value="downloadProgress || 0"
    />
    <RadialIndicator
      v-else-if="mode === 'progress'"
      slot="end"
      key="playbackProgress"
      color="medium"
      :value="playbackProgress || 0"
    />
  </Transition>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { IconIndicator, RadialIndicator, type StateIcon } from '@ui/components/tracks/state/index.js'
import type { UiTrackState } from '@ui/components/tracks/list/index.js'

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = defineProps<{
  state: UiTrackState
  /** 0..100 — drives the radial when the track is being downloaded. */
  downloadProgress?: number
  /** 0..100 — drives the radial during active playback. */
  playbackProgress?: number
}>()

/* -------------------------------------------------------------------------- */
/*                                  Derived                                   */
/* -------------------------------------------------------------------------- */

const icon = computed<StateIcon>(() => {
  if (props.state === 'failed') return 'failed'
  if (props.state === 'completed') return 'completed'
  if (props.state === 'added') return 'added'
  return 'none'
})

const mode = computed<'downloading' | 'icon' | 'progress' | undefined>(() => {
  if (props.state === 'downloading') return 'downloading'
  if (props.state === 'failed' || props.state === 'completed') return 'icon'
  if (props.state === 'playing' || props.state === 'added') return 'progress'
  return undefined
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
