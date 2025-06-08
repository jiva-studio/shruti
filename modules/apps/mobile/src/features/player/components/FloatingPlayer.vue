<template>
  <PlayerControls
    :playing="playing"
    :title="title"
    :author="author"
    :duration="duration"
    :position="position"
    :class="{
      'player': true,
      'floating': !isSticked,
      'stick': isSticked,
      'hidden': hidden
    }"
    @play="togglePause"
    @click="isSticked = !isSticked"
  />
</template>

<script setup lang="ts">
import { usePlayerControlsPlayerScenario } from '../composables/usePlayerControlsPlayerScenario'
import { default as PlayerControls } from './PlayerControls.vue'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const { togglePause } = usePlayerControlsPlayerScenario()

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  playing: boolean
  title: string
  author: string
  hidden: boolean
  duration: number
  position: number
}>()

const isSticked = defineModel<boolean>('sticked', { default: true, required: true })
</script>

<style scoped>
.player {
  z-index: 10000;
  position: fixed;
  transition: all .5s ease-in-out;
}

.floating {
  bottom: calc(56px + var(--ion-safe-area-bottom));
  height: 58px;
  left: 16px;
  right: 16px;
  border-radius: 10px;
}

.stick {
  height: calc(56px + (var(--ion-safe-area-bottom)));
  padding-bottom: calc(var(--ion-safe-area-bottom));

  bottom: 0px; 
  left: 0px;
  right: 0px;
  border-top-left-radius: 5px;
  border-top-right-radius: 5px;
}

.hidden {
  opacity: 0;
  bottom: 0;
  pointer-events: none;
}
</style>
