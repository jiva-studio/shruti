<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useDragPump, type DragRect } from "./useDragPump.js"
import {
  findNearestPreset,
  formatRate,
  fractionFromClientX,
  leftCalc,
  presetLeftFraction,
} from "./speedSliderGeometry.js"

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
    // Even quarter steps from 0.75× to 2× — six positions total.
    presets: () => [0.75, 1.0, 1.25, 1.5, 1.75, 2.0],
  }
)

const emit = defineEmits<{
  "update:modelValue": [value: number]
  /** Emitted when the puck crosses into a new nearest-preset zone during
   *  drag — purely a haptic cue, no payload. */
  snap: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const root = ref<HTMLElement | null>(null)
const livePosition = ref(props.modelValue)
let lastNearest = props.modelValue

const { dragging, onPointerDown: onPuckPointerDown } = useDragPump({
  trackEl: () => root.value?.querySelector(".track") as HTMLElement | null,
  onMove: (clientX, _y, rect) => applyFromClientX(clientX, rect),
  onCommit: commitDrag,
})

watch(
  () => props.modelValue,
  (next) => {
    if (!dragging.value) livePosition.value = next
  }
)

const minPreset = computed(() => props.presets[0])
const maxPreset = computed(() => props.presets[props.presets.length - 1])

function railFraction(rate: number): number {
  return presetLeftFraction(rate, minPreset.value, maxPreset.value)
}

function tickStyle(rate: number): Record<string, string> {
  return { left: leftCalc(railFraction(rate)) }
}

const puckStyle = computed(() => ({
  left: leftCalc(railFraction(livePosition.value)),
  transition: dragging.value ? "none" : "left 0.2s ease-out",
}))

const nearestPreset = computed(() => findNearestPreset(livePosition.value, props.presets))

/* -------------------------------------------------------------------------- */
/*                                Drag handling                               */
/* -------------------------------------------------------------------------- */

function commitDrag(): void {
  // Always commit to a preset on release — magnetic snap.
  const target = findNearestPreset(livePosition.value, props.presets)
  livePosition.value = target
  if (target !== props.modelValue) emit("update:modelValue", target)
}

function applyFromClientX(clientX: number, rect: DragRect): void {
  if (rect.width <= 0) return
  const fraction = fractionFromClientX(clientX, rect.left, rect.width)
  const min = minPreset.value
  const max = maxPreset.value
  const continuous = min + fraction * (max - min)
  livePosition.value = continuous
  // Boundary-cross haptic: emit when the nearest-preset zone changes
  // during drag, so the parent can fire a tiny tick.
  const nearest = findNearestPreset(continuous, props.presets)
  if (nearest !== lastNearest) {
    emit("snap")
    lastNearest = nearest
  }
}
</script>

<template>
  <div ref="root" class="speed-slider">
    <div class="track">
      <div class="rail" />
      <span
        v-for="(p, i) in presets"
        :key="i"
        class="tick"
        :class="{ active: nearestPreset === p }"
        :style="tickStyle(p)"
      />
      <!-- Drag only by the puck. No tap-to-jump on the rail/ticks —
           those need to bubble up so the carousel page-swipe still
           works inside the slider's footprint. -->
      <div class="puck" :style="puckStyle" @pointerdown="onPuckPointerDown">
        <!-- Live readout, only while the user is actively dragging.
             Shows the current snap target so the user knows what
             value they'd commit to if they let go right now. -->
        <span v-if="dragging" class="drag-label">{{ formatRate(nearestPreset) }}×</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.speed-slider {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
  user-select: none;
  touch-action: pan-y;
}

.speed-slider * {
  box-sizing: border-box;
}

.track {
  position: relative;
  flex: 1;
  height: 28px;
  display: block;
}

.rail {
  position: absolute;
  /* Vertically centred — same line as the Play button's centre.
     Inset by half the puck width so the puck at extreme presets
     stays inside the track footprint. PUCK_HALF in script must
     match this inset. */
  top: 50%;
  transform: translateY(-50%);
  left: 10px;
  right: 10px;
  height: 4px;
  background: rgba(var(--ion-color-primary-contrast-rgb), 0.35);
  border-radius: 2px;
}

.tick {
  position: absolute;
  top: 50%;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(var(--ion-color-primary-contrast-rgb), 0.55);
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
  /* Centred on the rail. Round, no text — matches the mix slider's
     puck for visual unity. PUCK_HALF in script (10) must match
     width/2 here. */
  top: 50%;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: #f4e7d2;
  background: color-mix(
    in srgb,
    var(--ion-color-primary-contrast) 88%,
    var(--ion-color-primary) 12%
  );
  border: 1.5px solid color-mix(in srgb, var(--ion-color-primary-shade) 35%, transparent);
  transform: translate(-50%, -50%);
  cursor: grab;
  touch-action: none;
}

.puck::before {
  content: "";
  position: absolute;
  inset: -9px;
  border-radius: 50%;
}

.drag-label {
  position: absolute;
  /* Floats just above the puck while dragging — small gap so it
     doesn't touch the border. Faded so it reads as an unobtrusive
     readout, not chrome. */
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  font-size: 0.55rem;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  color: rgba(var(--ion-color-primary-contrast-rgb), 0.6);
  pointer-events: none;
}
</style>
