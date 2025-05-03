<template>
  <PlayerControls
    :playing="isPlaying"
    :title="title"
    :author="author"
    :class="{
      'player': true,
      'closed': !isPlayerTranscriptOpen,
      'opened': isPlayerTranscriptOpen,
      'hidden': !isVisible
    }"
    @play="togglePause"
    @click="toggleTranscriptOpen"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { 
  PlayerControls,usePlayerControls,
  usePlayerTranscript,
  usePlayerControlsPlayerScenario
} from '@lectorium/mobile/player'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const { isPlaying, title, author } = usePlayerControls()
const { isOpen: isPlayerTranscriptOpen, toggleTranscriptOpen } = usePlayerTranscript()
const { togglePause } = usePlayerControlsPlayerScenario()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const isVisible = computed(() => {
  return title.value !== '' || author.value !== ''
})
</script>

<style scoped>
.player {
  z-index: 100000;
  position: fixed;
  transition: all .5s ease-in-out;
}

.closed {
  bottom: calc(56px + var(--ion-safe-area-bottom));
  height: 58px;
  left: 16px;
  right: 16px;
  border-radius: 10px;
}

.opened {
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
