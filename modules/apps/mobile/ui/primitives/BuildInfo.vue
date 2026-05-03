<template>
  <p class="build-info" @click="emit('tap')">
    v{{ version }} ({{ buildId }})
    <span class="build-info-db"> DB {{ dbNumber ?? "—" }} · scheme {{ dbScheme }} </span>
  </p>
</template>

<script setup lang="ts">
defineProps<{
  version: string
  buildId: string
  dbNumber: string | null
  dbScheme: number
}>()

const emit = defineEmits<{
  tap: []
}>()
</script>

<style scoped>
.build-info {
  font-size: 0.75em;
  color: var(--ion-color-medium);
  text-align: center;
  margin-top: 24px;
  /* Bottom space below the version label is reserved by AppPage's
   * `reserve-player-space` flag (mini-player height) plus the system
   * safe-area inset. Don't duplicate it here. */
  padding: 12px 16px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: opacity 120ms ease;
}

.build-info:active {
  opacity: 0.5;
}

.build-info-db {
  display: block;
  margin-top: 2px;
  opacity: 0.75;
}
</style>
