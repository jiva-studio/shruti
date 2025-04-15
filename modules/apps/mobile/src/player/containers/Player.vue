<template>
  <PlayerControls
    :playing="isPlaying"
    :class="{
      'player': true,
      'closed': !isPlayerTranscriptOpen,
      'opened': isPlayerTranscriptOpen
    }"
    @play="isPlaying = !isPlaying"
    @click="isPlayerTranscriptOpen = !isPlayerTranscriptOpen"
  />
  <PlayerTranscript v-model:open="isPlayerTranscriptOpen" />
</template>

<script setup lang="ts">
import { PlayerControls, PlayerTranscript, usePlayerControls, usePlayerTranscript } from '@/player'

/* -------------------------------------------------------------------------- */
/*                                Dependencies                                */
/* -------------------------------------------------------------------------- */

const { isPlaying } = usePlayerControls()
const { isOpen: isPlayerTranscriptOpen } = usePlayerTranscript()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

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
</style>
