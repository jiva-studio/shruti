<script setup lang="ts">
defineProps<{
  playing: boolean
  speed: number
  speeds: number[]
  busy: boolean
}>()

const emit = defineEmits<{
  toggle: []
  "update:speed": [value: number]
}>()

function formatSpeed(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return `×${rounded}`
}

function onSpeedChange(event: Event): void {
  emit("update:speed", Number((event.target as HTMLSelectElement).value))
}
</script>

<template>
  <div class="player-left">
    <button
      type="button"
      class="play-btn"
      :aria-label="playing ? 'Pause' : 'Play'"
      :disabled="busy"
      @click="emit('toggle')"
    >
      <span v-if="busy" class="play-spinner"><slot name="spinner" /></span>
      <svg v-else-if="playing" viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
        <path d="M9 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" />
        <path d="M17 4h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
        <path
          d="M6 4v16a1 1 0 0 0 1.524 .852l13 -8a1 1 0 0 0 0 -1.704l-13 -8a1 1 0 0 0 -1.524 .852z"
        />
      </svg>
    </button>
    <select class="speed-select" aria-label="Playback speed" :value="speed" @change="onSpeedChange">
      <option v-for="s in speeds" :key="s" :value="s">{{ formatSpeed(s) }}</option>
    </select>
  </div>
</template>

<style scoped>
.player-left {
  grid-column: 1;
  grid-row: 1 / span 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.play-btn {
  flex-shrink: 0;
  width: 46px;
  height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
  cursor: pointer;
  transition: background 150ms ease;
  -webkit-tap-highlight-color: transparent;
}

.play-btn:hover:not(:disabled) {
  background: var(--ion-color-primary-shade);
}

.play-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.play-spinner {
  --color: var(--ion-color-primary-contrast);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
}
.play-spinner :deep(*) {
  width: 100%;
  height: 100%;
}

.speed-select {
  flex-shrink: 0;
  appearance: none;
  -webkit-appearance: none;
  padding: 0;
  border: none;
  background: transparent;
  color: rgba(var(--ion-color-medium-rgb), 0.55);
  font-size: 0.8rem;
  font-weight: 600;
  text-align: center;
  text-align-last: center;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.speed-select:hover {
  color: var(--ion-color-primary);
}
</style>
