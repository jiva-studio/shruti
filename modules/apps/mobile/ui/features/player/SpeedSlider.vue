<template>
  <div ref="root" class="speed-slider">
    <div class="track" @pointerdown="onTrackPointerDown">
      <div class="rail" />
      <span
        v-for="(p, i) in presets"
        :key="i"
        class="tick"
        :class="{ active: nearestPreset === p }"
        :style="{ left: presetLeftPct(p) + '%' }"
      />
      <div class="puck" :style="{ left: puckLeftPct + '%' }" @pointerdown="onPuckPointerDown">
        <span class="label">{{ formatRate(displayValue) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = withDefaults(
  defineProps<{
    /** Current playback rate. Stored value is one of `presets` after each commit. */
    modelValue: number
    /** Magnetic snap points. Sorted ascending. Min and max are also the slider bounds. */
    presets?: readonly number[]
  }>(),
  {
    presets: () => [0.75, 1.0, 1.25, 1.5, 2.0],
  }
)

const emit = defineEmits<{
  "update:modelValue": [value: number]
  /** Emitted when the puck crosses into a new nearest-preset zone during drag. */
  snap: [value: number]
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const root = ref<HTMLElement | null>(null)
const dragging = ref(false)
const livePosition = ref(props.modelValue)
let pointerId: number | null = null
let trackRectLeft = 0
let trackRectWidth = 0
let lastNearest = props.modelValue

watch(
  () => props.modelValue,
  (next) => {
    if (!dragging.value) livePosition.value = next
  }
)

const minPreset = computed(() => props.presets[0])
const maxPreset = computed(() => props.presets[props.presets.length - 1])

/** Where, in [0, 1], does this rate sit on the slider? Linear in rate-space
 *  is fine for a 5-preset slider; the perception step between 1× and
 *  1.25× is comparable to 1.5× and 1.75×. */
function presetLeftFraction(rate: number): number {
  const min = minPreset.value
  const max = maxPreset.value
  return (rate - min) / (max - min)
}

function presetLeftPct(rate: number): string {
  return (presetLeftFraction(rate) * 100).toFixed(2)
}

const puckLeftPct = computed(() => (presetLeftFraction(livePosition.value) * 100).toFixed(2))

const displayValue = computed(() => {
  // While dragging show the value the puck would commit to right now —
  // i.e. the nearest preset. Outside drag show the persisted value.
  if (dragging.value) return findNearestPreset(livePosition.value)
  return props.modelValue
})

const nearestPreset = computed(() => findNearestPreset(livePosition.value))

function findNearestPreset(value: number): number {
  let best = props.presets[0]
  let bestDist = Math.abs(value - best)
  for (const p of props.presets) {
    const d = Math.abs(value - p)
    if (d < bestDist) {
      best = p
      bestDist = d
    }
  }
  return best
}

function formatRate(rate: number): string {
  // 1 → "1×", 1.25 → "1.25×", 0.75 → "0.75×".
  if (Number.isInteger(rate)) return `${rate}×`
  return `${rate.toString().replace(/\.0+$/, "")}×`
}

/* -------------------------------------------------------------------------- */
/*                                Drag handling                               */
/* -------------------------------------------------------------------------- */

function startDrag(e: PointerEvent): void {
  if (!root.value) return
  const trackEl = root.value.querySelector(".track") as HTMLElement | null
  if (!trackEl) return
  const rect = trackEl.getBoundingClientRect()
  trackRectLeft = rect.left
  trackRectWidth = rect.width
  pointerId = e.pointerId
  dragging.value = true
  ;(e.target as Element).setPointerCapture?.(e.pointerId)
  applyFromClientX(e.clientX)
  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
  window.addEventListener("pointercancel", onPointerUp)
  e.stopPropagation()
}

function onPuckPointerDown(e: PointerEvent): void {
  startDrag(e)
}

function onTrackPointerDown(e: PointerEvent): void {
  // Tap on a tick or anywhere on the rail jumps the puck there. Lets
  // the user reach 2× without dragging.
  startDrag(e)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value || e.pointerId !== pointerId) return
  applyFromClientX(e.clientX)
}

function onPointerUp(e: PointerEvent): void {
  if (e.pointerId !== pointerId) return
  dragging.value = false
  pointerId = null
  window.removeEventListener("pointermove", onPointerMove)
  window.removeEventListener("pointerup", onPointerUp)
  window.removeEventListener("pointercancel", onPointerUp)
  // Always commit to a preset on release — magnetic snap.
  const target = findNearestPreset(livePosition.value)
  livePosition.value = target
  if (target !== props.modelValue) emit("update:modelValue", target)
}

function applyFromClientX(clientX: number): void {
  if (trackRectWidth <= 0) return
  const x = clientX - trackRectLeft
  const fraction = Math.max(0, Math.min(1, x / trackRectWidth))
  const min = minPreset.value
  const max = maxPreset.value
  const continuous = min + fraction * (max - min)
  livePosition.value = continuous
  // Boundary-cross haptic: emit when the nearest-preset zone changes
  // during drag, so the parent can fire a tiny tick.
  const nearest = findNearestPreset(continuous)
  if (nearest !== lastNearest) {
    emit("snap", nearest)
    lastNearest = nearest
  }
}
</script>

<style scoped>
.speed-slider {
  display: flex;
  align-items: center;
  width: 100%;
  height: 44px;
  padding: 0 12px;
  user-select: none;
  touch-action: pan-y;
}

.track {
  position: relative;
  flex: 1;
  height: 28px;
  display: flex;
  align-items: center;
}

.rail {
  position: absolute;
  left: 0;
  right: 0;
  height: 4px;
  background: rgba(255, 255, 255, 0.35);
  border-radius: 2px;
}

.tick {
  position: absolute;
  top: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.55);
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition:
    transform 0.15s ease,
    background 0.15s ease;
}

.tick.active {
  background: var(--ion-color-primary-contrast, #fff);
  transform: translate(-50%, -50%) scale(1.5);
}

.puck {
  position: absolute;
  top: 50%;
  min-width: 44px;
  height: 26px;
  padding: 0 10px;
  border-radius: 13px;
  background: var(--ion-color-primary-contrast, #fff);
  color: var(--ion-color-primary-shade, #2a73c2);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.8rem;
  cursor: grab;
  touch-action: none;
}

.puck::before {
  content: "";
  position: absolute;
  inset: -8px;
  border-radius: 21px;
}

.label {
  position: relative;
  z-index: 1;
}
</style>
