<template>
  <div ref="root" class="mix-control">
    <span class="label left">{{ leftLabel }}</span>
    <div class="track">
      <div class="rail left" />
      <div class="deadzone" />
      <div class="rail right" />
      <!-- pointerdown only on the puck itself: pointerdown elsewhere
           inside the player must bubble up so the carousel can claim
           the swipe and switch pages. -->
      <div
        class="puck"
        :class="{ engaged }"
        :style="{ left: puckLeftPct + '%' }"
        @pointerdown="onPointerDown"
      />
    </div>
    <span class="label right">{{ rightLabel }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = withDefaults(
  defineProps<{
    /** Slider position in [-1, +1]. 0 = mix OFF / native stereo. */
    modelValue: number
    /** Label drawn at the left edge — e.g. "EN". */
    leftLabel?: string
    /** Label drawn at the right edge — e.g. "RU". */
    rightLabel?: string
    /** Half-width of the centre detent in normalized [0,1]. The puck
     *  snaps back to 0 when released anywhere within ±deadzone. */
    deadzone?: number
  }>(),
  {
    leftLabel: "L",
    rightLabel: "R",
    deadzone: 0.08,
  }
)

const emit = defineEmits<{
  "update:modelValue": [value: number]
  /** Emitted when the puck visibly crosses the deadzone boundary
   *  (engages or disengages the mix). The parent uses this for
   *  haptic feedback. */
  "boundary-cross": [direction: "engage" | "disengage"]
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
let lastEngaged = Math.abs(props.modelValue) > props.deadzone

watch(
  () => props.modelValue,
  (next) => {
    if (!dragging.value) livePosition.value = next
  }
)

const engaged = computed(() => Math.abs(livePosition.value) > props.deadzone)

// Map slider value [-1,+1] linearly to puck centre [0,100]%.
const puckLeftPct = computed(() => ((livePosition.value + 1) / 2) * 100)

/* -------------------------------------------------------------------------- */
/*                                Drag handling                               */
/* -------------------------------------------------------------------------- */

function onPointerDown(e: PointerEvent): void {
  if (!root.value) return
  const trackEl = root.value.querySelector(".track") as HTMLElement | null
  if (!trackEl) return
  const rect = trackEl.getBoundingClientRect()
  trackRectLeft = rect.left
  trackRectWidth = rect.width
  pointerId = e.pointerId
  dragging.value = true
  // Capture so we keep getting move events even if the finger leaves
  // the track horizontally.
  ;(e.target as Element).setPointerCapture?.(e.pointerId)
  applyFromClientX(e.clientX)
  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
  window.addEventListener("pointercancel", onPointerUp)
  // Stop the event so the parent FloatingPlayer's carousel gesture
  // recognizer doesn't claim this drag as a page swipe.
  e.stopPropagation()
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
  // Snap back to centre if the user released inside the detent. Floating-
  // point exact zero matters: usePlayerStore derives `enabled` from
  // `mixPosition !== 0`.
  if (Math.abs(livePosition.value) < props.deadzone) {
    commit(0)
  } else {
    commit(livePosition.value)
  }
}

function applyFromClientX(clientX: number): void {
  if (trackRectWidth <= 0) return
  const x = clientX - trackRectLeft
  let p = (x / trackRectWidth) * 2 - 1
  if (p < -1) p = -1
  if (p > 1) p = 1
  // Inside the deadzone the puck still tracks the finger visually
  // (otherwise the centre feels "dead" and unresponsive), but we don't
  // commit a non-zero mixPosition until the boundary is crossed.
  livePosition.value = p
  if (Math.abs(p) > props.deadzone) commit(p)
  else commit(0)
}

function commit(value: number): void {
  // Snap exact-zero to defeat float drift. Without this, releasing the
  // puck "near zero" can leave mixPosition at 1e-7, which evaluates as
  // truthy and keeps the mix processor engaged.
  const v = Math.abs(value) < 1e-3 ? 0 : value
  if (v !== props.modelValue) emit("update:modelValue", v)
  const nowEngaged = Math.abs(v) > props.deadzone
  if (nowEngaged !== lastEngaged) {
    emit("boundary-cross", nowEngaged ? "engage" : "disengage")
    lastEngaged = nowEngaged
  }
}
</script>

<style scoped>
.mix-control {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 44px;
  padding: 0 12px;
  user-select: none;
  touch-action: pan-y;
}

.label {
  font-size: 0.75rem;
  font-weight: 600;
  opacity: 0.8;
  flex-shrink: 0;
  min-width: 18px;
  text-align: center;
}

.track {
  position: relative;
  flex: 1;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.rail {
  height: 4px;
  width: 42%;
  background: rgba(255, 255, 255, 0.35);
  border-radius: 2px;
}

.deadzone {
  width: 16%;
  height: 4px;
  /* Visual gap between the rails — no background of its own. */
}

.puck {
  position: absolute;
  top: 50%;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--ion-color-primary-contrast, #fff);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
  transform: translate(-50%, -50%);
  transition:
    box-shadow 0.15s ease,
    background 0.15s ease;
  /* Visually 18 px, but a 36 px tap target via an invisible expansion so
     a sloppy finger still grabs the puck instead of falling through to
     the carousel swipe gesture. */
  cursor: grab;
  touch-action: none;
}

.puck::before {
  content: "";
  position: absolute;
  inset: -9px;
  border-radius: 50%;
}

.puck.engaged {
  background: var(--ion-color-primary-shade, #2a73c2);
  box-shadow:
    0 0 0 3px rgba(255, 255, 255, 0.55),
    0 1px 6px rgba(0, 0, 0, 0.45);
}
</style>
