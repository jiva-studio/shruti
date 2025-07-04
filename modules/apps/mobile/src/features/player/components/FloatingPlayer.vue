<template>
  <PlayerControls
    :playing="playing"
    :title="title"
    :author="author"
    :duration="duration"
    :position="position"
    :show-progress="showProgress"
    :class="{
      'player': true,
      'floating': !sticked,
      'stick': sticked,
      'hidden': hidden
    }"
    @play="emit('playClicked')"
  />
</template>

<script setup lang="ts">
import { defineEmits } from 'vue'
import { default as PlayerControls } from './PlayerControls.vue'

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
  showProgress: boolean
  sticked: boolean
}>()

const emit = defineEmits<{
  playClicked: []
}>()
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
