<template>
  <div ref="root" class="source-mix-control">
    <span class="label left">{{ leftLabel }}</span>
    <div class="track">
      <div class="rail" />
      <div class="fill" :style="{ width: puckLeftPct + '%' }" />
      <!-- pointerdown only on the puck; elsewhere bubbles to the carousel. -->
      <div class="puck" :style="{ left: puckLeftPct + '%' }" @pointerdown="onPointerDown" />
    </div>
    <span class="label right">{{ rightLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useDragPump, type DragRect } from "./useDragPump.js"

/**
 * Single-ended slider [0..1] that blends the noisy original (left, 0) with
 * the denoised clean version (right, 1). Unlike MixControl there is no centre
 * detent — any position is valid and committed live. Default 0 plays the
 * original. A haptic `tick` fires at the endpoints.
 */
const props = withDefaults(
  defineProps<{
    /** Mix level in [0, 1]. 0 = original, 1 = clean. */
    modelValue: number
    /** Label at the left edge (original). */
    leftLabel?: string
    /** Label at the right edge (clean). */
    rightLabel?: string
  }>(),
  { leftLabel: "Original", rightLabel: "Clean" }
)

const emit = defineEmits<{
  "update:modelValue": [value: number]
  /** One light haptic when the puck reaches an endpoint (0 or 1). */
  tick: []
}>()

const root = ref<HTMLElement | null>(null)
const livePosition = ref(clamp01(props.modelValue))
let lastEndpoint = endpointOf(props.modelValue)

const { dragging, onPointerDown } = useDragPump({
  trackEl: () => root.value?.querySelector(".track") as HTMLElement | null,
  onMove: (clientX, _y, rect) => applyFromClientX(clientX, rect),
  onCommit: () => commit(livePosition.value),
})

watch(
  () => props.modelValue,
  (next) => {
    if (!dragging.value) livePosition.value = clamp01(next)
  }
)

const puckLeftPct = computed(() => livePosition.value * 100)

function applyFromClientX(clientX: number, rect: DragRect): void {
  if (rect.width <= 0) return
  const p = clamp01((clientX - rect.left) / rect.width)
  livePosition.value = p
  commit(p)
}

function commit(value: number): void {
  const v = clamp01(value)
  if (v !== props.modelValue) emit("update:modelValue", v)
  const ep = endpointOf(v)
  if (ep !== lastEndpoint) {
    if (ep !== null) emit("tick")
    lastEndpoint = ep
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

/** "min" at 0, "max" at 1, null in between — used to tick only at the ends. */
function endpointOf(v: number): "min" | "max" | null {
  if (v <= 1e-3) return "min"
  if (v >= 1 - 1e-3) return "max"
  return null
}
</script>

<style scoped>
.source-mix-control {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 44px;
  padding: 0 12px;
  user-select: none;
  touch-action: pan-y;
}

.source-mix-control * {
  box-sizing: border-box;
}

.label {
  font-size: 0.75rem;
  font-weight: 600;
  opacity: 0.85;
  white-space: nowrap;
}

.track {
  position: relative;
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
}

.rail {
  position: absolute;
  left: 0;
  right: 0;
  height: 4px;
  border-radius: 2px;
  background: rgba(var(--ion-color-primary-contrast-rgb), 0.3);
}

.fill {
  position: absolute;
  left: 0;
  height: 4px;
  border-radius: 2px;
  background: rgba(var(--ion-color-primary-contrast-rgb), 0.85);
}

.puck {
  position: absolute;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--ion-color-primary-contrast);
  transform: translateX(-50%);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
  touch-action: none;
}
</style>
