<template>
  <div
    v-if="!isPlayerTranscriptOpen"
    class="NavigationBarHolder"
  />
</template>

<script setup lang="ts">
import { usePlayerTranscript } from '@/player'
const { isOpen: isPlayerTranscriptOpen } = usePlayerTranscript()
</script>

<style scoped>
.NavigationBarHolder {
  background-color: white;
  position: fixed;
  left: 0px;
  right: 0px;
  bottom: 0px;
  height: var(--ion-safe-area-bottom);
}
</style>