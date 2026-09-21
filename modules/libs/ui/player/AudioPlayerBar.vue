<script setup lang="ts">
import { computed, useTemplateRef } from "vue"
import PlayerControls from "./PlayerControls.vue"

const props = withDefaults(
  defineProps<{
    playing: boolean
    positionMs: number
    durationMs: number
    speed: number
    speeds?: number[]
    title?: string
    subtitle?: string
    busy?: boolean
  }>(),
  {
    speeds: () => [0.75, 1, 1.25, 1.5, 1.75, 2],
    busy: false,
  }
)

const emit = defineEmits<{
  toggle: []
  "skip-back": []
  "skip-forward": []
  seek: [ms: number]
  "update:speed": [value: number]
}>()

const trackEl = useTemplateRef<HTMLDivElement>("trackEl")

const fraction = computed(() => {
  if (!props.durationMs || props.durationMs <= 0) return 0
  const f = props.positionMs / props.durationMs
  return f < 0 ? 0 : f > 1 ? 1 : f
})

const fillStyle = computed(() => ({ width: `${fraction.value * 100}%` }))
const thumbStyle = computed(() => ({ left: `${fraction.value * 100}%` }))

function seekFromClientX(clientX: number) {
  const el = trackEl.value
  if (!el || !props.durationMs) return
  const rect = el.getBoundingClientRect()
  let f = (clientX - rect.left) / rect.width
  if (f < 0) f = 0
  if (f > 1) f = 1
  emit("seek", Math.round(f * props.durationMs))
}

function onPointerDown(event: PointerEvent) {
  const el = trackEl.value
  if (!el) return
  el.setPointerCapture(event.pointerId)
  seekFromClientX(event.clientX)
  const move = (e: PointerEvent) => seekFromClientX(e.clientX)
  const up = () => {
    el.removeEventListener("pointermove", move)
    el.removeEventListener("pointerup", up)
    el.removeEventListener("pointercancel", up)
  }
  el.addEventListener("pointermove", move)
  el.addEventListener("pointerup", up)
  el.addEventListener("pointercancel", up)
}
</script>

<template>
  <div class="player-bar">
    <div v-if="title || subtitle || $slots.title" class="player-meta">
      <slot name="title">
        <div v-if="title" class="player-title">{{ title }}</div>
        <div v-if="subtitle" class="player-subtitle">{{ subtitle }}</div>
      </slot>
    </div>

    <div class="player-main">
      <PlayerControls
        :playing="playing"
        :speed="speed"
        :speeds="speeds"
        :busy="busy"
        @toggle="emit('toggle')"
        @update:speed="emit('update:speed', $event)"
      >
        <template #spinner><slot name="spinner" /></template>
      </PlayerControls>

      <div class="player-center">
        <div v-if="$slots.waveform" class="player-waveform">
          <slot name="waveform" />
        </div>
        <div
          v-else
          ref="trackEl"
          class="seek-track"
          role="slider"
          :aria-valuemin="0"
          :aria-valuemax="durationMs"
          :aria-valuenow="positionMs"
          @pointerdown="onPointerDown"
        >
          <div class="seek-fill" :style="fillStyle" />
          <div class="seek-thumb" :style="thumbStyle" />
        </div>
      </div>

      <div v-if="$slots.below" class="player-below">
        <slot name="below" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.player-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--ion-color-light);
  border: 1px solid var(--ion-border-color);
  border-radius: 10px;
}

.player-meta {
  min-width: 0;
}

.player-title {
  font-family: var(--font-serif, serif);
  font-weight: 600;
  color: var(--ion-text-color);
  line-height: 1.3;
}

.player-subtitle {
  font-size: 0.85rem;
  color: var(--ion-color-medium);
  margin-top: 2px;
}

.player-main {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  column-gap: 16px;
  row-gap: 8px;
}

.player-center {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  display: flex;
}

.player-below {
  grid-column: 2;
  grid-row: 2;
  min-width: 0;
}

.ctrl-btn {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ion-color-tertiary);
  cursor: pointer;
  border-radius: 50%;
  transition: background 150ms ease;
  -webkit-tap-highlight-color: transparent;
}

.ctrl-btn:hover:not(:disabled) {
  background: rgba(var(--ion-color-tertiary-rgb), 0.08);
}

.ctrl-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.ctrl-label {
  position: absolute;
  bottom: 2px;
  font-size: 0.48rem;
  font-weight: 700;
  line-height: 1;
}

.player-waveform {
  display: flex;
  width: 100%;
}

.seek-track {
  position: relative;
  flex: 1;
  height: 18px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}

.seek-track::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  height: 5px;
  border-radius: 999px;
  background: rgba(var(--ion-color-medium-rgb), 0.25);
}

.seek-fill {
  position: absolute;
  left: 0;
  height: 5px;
  border-radius: 999px;
  background: var(--ion-color-primary);
}

.seek-thumb {
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--ion-color-primary);
  border: 2px solid var(--ion-color-light);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transform: translateX(-50%);
}
</style>
