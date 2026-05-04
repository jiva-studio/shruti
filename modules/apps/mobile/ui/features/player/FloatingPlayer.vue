<template>
  <!-- No Teleport: the parent (App.vue) renders us directly inside
       <IonApp>, which is the same DOM container Ionic mounts its
       overlays into (action-sheet, alert, modal, toast, popover —
       see @ionic/core .../overlays.js: getAppRoot returns ion-app).
       Sitting in the same container means Ionic's :host z-index: 1001
       actually competes with our z-index — see .player below. -->
  <div
    ref="root"
    :class="{
      player: true,
      floating: !sticked,
      stick: sticked,
      hidden: hidden,
      pulsing: pulsing,
    }"
    @pointerdown="onPointerDown"
    @click="onClick"
  >
    <div class="pages-viewport">
      <div
        class="pages-track"
        :style="{
          transform: `translateX(calc(${-page * 100}% + ${dragOffset}px))`,
          transition: pointerId === null ? 'transform 0.25s ease-out' : 'none',
        }"
      >
        <div class="page">
          <PlayerControls :title="title" :author="author" :play-button-size="playButtonSize" />
        </div>
        <div class="page">
          <SpeedSkipPanel
            :model-value="playbackSpeed"
            :play-slot-width="playButtonSize"
            @update:model-value="(v: number) => emit('update:playbackSpeed', v)"
            @snap="onSpeedSnap"
            @skip-back="emit('skipBack')"
            @skip-forward="emit('skipForward')"
          />
        </div>
        <div class="page">
          <MixControl
            :model-value="mixPosition"
            left-label="L"
            right-label="R"
            @update:model-value="(v: number) => emit('update:mixPosition', v)"
            @boundary-cross="(d: 'engage' | 'disengage') => emit('mixBoundaryCross', d)"
          />
        </div>
      </div>
    </div>

    <!-- Shared Play overlay: a single button that travels across pages
         0 ↔ 1 (right edge → left edge) and continues sliding off-screen
         to the left between pages 1 ↔ 2, "stuck" to page 1. -->
    <div
      ref="playEl"
      class="shared-play"
      :class="{ disabled: playOffscreen, completed: trackCompleted }"
      :style="{
        transform: `translate(${playX}px, -50%)`,
        width: playButtonSize + 'px',
        height: playButtonSize + 'px',
        transition: pointerId === null ? 'transform 0.25s ease-out' : 'none',
      }"
      :aria-hidden="hidden || playOffscreen"
      @pointerdown.stop
      @click.stop="onPlayClick"
    >
      <IonIcon class="icon" :icon="playIcon" />
      <div v-if="showProgress" class="progress">
        <RadialProgress
          :stroke-width="4"
          :inner-stroke-width="4"
          :diameter="playButtonSize"
          :completed-steps="position"
          :total-steps="duration"
          :animate-speed="750"
          start-color="rgba(255, 255, 255, .65)"
          stop-color="rgba(255, 255, 255, .65)"
          inner-stroke-color="rgba(255, 255, 255, 0)"
        />
      </div>
    </div>

    <div class="page-dots" :aria-hidden="hidden">
      <span :class="{ dot: true, active: page === 0 }" />
      <span :class="{ dot: true, active: page === 1 }" />
      <span :class="{ dot: true, active: page === 2 }" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { IonIcon } from "@ionic/vue"
import { play, pause, checkmarkDone } from "ionicons/icons"
import RadialProgress from "vue3-radial-progress"
import MixControl from "./MixControl.vue"
import PlayerControls from "./PlayerControls.vue"
import SpeedSkipPanel from "./SpeedSkipPanel.vue"

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

const props = withDefaults(
  defineProps<{
    playing: boolean
    title: string
    author: string
    hidden: boolean
    duration: number
    position: number
    showProgress: boolean
    sticked: boolean
    pulsing: boolean
    /** Stereo-mix slider position in [-1, +1]. 0 = mix OFF / native stereo. */
    mixPosition: number
    /** Playback speed (1.0 = normal). */
    playbackSpeed: number
    /** Diameter (px) of the shared Play button. */
    playButtonSize?: number
  }>(),
  { playButtonSize: 44 }
)

const emit = defineEmits<{
  playClicked: []
  click: []
  "update:mixPosition": [value: number]
  mixBoundaryCross: [direction: "engage" | "disengage"]
  "update:playbackSpeed": [value: number]
  speedSnap: [value: number]
  skipBack: []
  skipForward: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const root = ref<HTMLElement | null>(null)
const playEl = ref<HTMLElement | null>(null)
const page = ref<number>(0)
const dragOffset = ref<number>(0)
const PAGE_COUNT = 3
const EDGE_PADDING = 8 // px between Play and the player's rounded edges

/** Reactive viewport width — kept up to date on resize so the shared
 *  Play overlay anchors correctly after orientation changes. */
const viewportWidth = ref<number>(0)

/* -------------------------------------------------------------------------- */
/*                                Page swipe                                  */
/* -------------------------------------------------------------------------- */

const pointerId = ref<number | null>(null)
let dragStartX = 0
let dragStartY = 0
let dragLocked: "horizontal" | "vertical" | null = null
let pageWidth = 0
const DRAG_LOCK_THRESHOLD = 8 // px before deciding direction
const PAGE_SWITCH_THRESHOLD = 0.25 // fraction of page width
const EDGE_BACK_GUARD_PX = 24 // ignore drags starting in the iOS edge-back zone

function onPointerDown(e: PointerEvent): void {
  if (props.hidden) return
  if (!root.value) return
  // Skip drags that originate inside the puck — MixControl swallows
  // those via stopPropagation, but if the user happens to start the
  // drag on the rail or label, page-swipe is the right behaviour.
  // The iOS system back-swipe owns the leftmost ~24 px; staying out
  // of that zone keeps navigation predictable.
  const rect = root.value.getBoundingClientRect()
  if (e.clientX - rect.left < EDGE_BACK_GUARD_PX) return
  pageWidth = rect.width
  pointerId.value = e.pointerId
  dragStartX = e.clientX
  dragStartY = e.clientY
  dragLocked = null
  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
  window.addEventListener("pointercancel", onPointerUp)
}

function onPointerMove(e: PointerEvent): void {
  if (e.pointerId !== pointerId.value) return
  const dx = e.clientX - dragStartX
  const dy = e.clientY - dragStartY
  if (dragLocked === null) {
    if (Math.abs(dx) < DRAG_LOCK_THRESHOLD && Math.abs(dy) < DRAG_LOCK_THRESHOLD) return
    dragLocked = Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical"
    if (dragLocked === "vertical") {
      cleanupDrag()
      return
    }
  }
  // Resist swiping past the first / last page so the user feels the
  // boundary instead of seeing an infinite slide.
  let offset = dx
  if (page.value === 0 && dx > 0) offset = dx * 0.3
  if (page.value === PAGE_COUNT - 1 && dx < 0) offset = dx * 0.3
  dragOffset.value = offset
}

function onPointerUp(e: PointerEvent): void {
  if (e.pointerId !== pointerId.value) return
  if (dragLocked === "horizontal" && pageWidth > 0) {
    const ratio = dragOffset.value / pageWidth
    if (ratio < -PAGE_SWITCH_THRESHOLD && page.value < PAGE_COUNT - 1) page.value += 1
    else if (ratio > PAGE_SWITCH_THRESHOLD && page.value > 0) page.value -= 1
  }
  dragOffset.value = 0
  cleanupDrag()
}

function cleanupDrag(): void {
  pointerId.value = null
  window.removeEventListener("pointermove", onPointerMove)
  window.removeEventListener("pointerup", onPointerUp)
  window.removeEventListener("pointercancel", onPointerUp)
}

onBeforeUnmount(cleanupDrag)

/* -------------------------------------------------------------------------- */
/*                            Shared Play overlay                             */
/* -------------------------------------------------------------------------- */

/**
 * `swipeProgress = page + dragOffset / viewportWidth`. Continuous from
 * 0 (page 0 fully visible) to PAGE_COUNT - 1 (last page).
 *
 * Play X anchors:
 *   0 → rightAnchor (page 0: right edge)
 *   1 → leftAnchor  (page 1: left edge)
 *   2 → leftAnchor − viewportWidth  (off-screen to the left, "glued" to page 1)
 *
 * Linear interp on each segment.
 */
const playX = computed(() => {
  const w = viewportWidth.value || pageWidth || 0
  if (w <= 0) return 0
  const t = page.value + dragOffset.value / Math.max(1, w)
  const rightAnchor = w - props.playButtonSize - EDGE_PADDING
  const leftAnchor = EDGE_PADDING
  const phase01 = Math.min(1, Math.max(0, t)) // 0..1 between page 0 and 1
  const phase12 = Math.max(0, t - 1) // 0..1 between page 1 and 2
  return rightAnchor + (leftAnchor - rightAnchor) * phase01 - phase12 * w
})

const playOffscreen = computed(() => {
  const w = viewportWidth.value || pageWidth || 0
  if (w <= 0) return false
  return playX.value + props.playButtonSize <= 0 || playX.value >= w
})

const trackCompleted = computed(() => props.duration > 0 && props.position >= props.duration)
const playIcon = computed(() => {
  if (trackCompleted.value) return checkmarkDone
  return props.playing ? pause : play
})

function onPlayClick(): void {
  if (trackCompleted.value) return
  emit("playClicked")
}

function onSpeedSnap(_value: number): void {
  emit("speedSnap", _value)
}

/* Resize handling — keep viewportWidth in sync so the Play overlay
 * stays anchored after orientation changes. */
let resizeObserver: ResizeObserver | null = null
function measure(): void {
  if (!root.value) return
  viewportWidth.value = root.value.getBoundingClientRect().width
}
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== "undefined" && root.value) {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(root.value)
  } else {
    window.addEventListener("resize", measure)
  }
})
onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  } else {
    window.removeEventListener("resize", measure)
  }
})

// Re-measure when the player toggles between floating and stick modes —
// width and height change at that moment.
watch(
  () => props.sticked,
  () => requestAnimationFrame(measure)
)
watch(
  () => props.hidden,
  (v) => {
    if (!v) requestAnimationFrame(measure)
  }
)

/* -------------------------------------------------------------------------- */
/*                                    Misc                                    */
/* -------------------------------------------------------------------------- */

function onClick(): void {
  // Suppress the synthesised click that follows a horizontal page swipe
  // — only taps on the free area should open the fullscreen view.
  if (dragLocked === "horizontal") {
    dragLocked = null
    return
  }
  emit("click")
}
</script>

<style scoped>
.player {
  /* Below Ionic overlays (action-sheet/alert/loading/toast/popover all
     use z-index ~1001 via :host). We're in the same DOM container
     (ion-app) as those overlays, so this comparison actually works. */
  z-index: 999;
  position: fixed;
  transition: all 0.5s ease-in-out;
  background-color: var(--ion-color-primary-tint);
  color: var(--ion-color-primary-contrast);
  overflow: hidden;
}

.floating {
  bottom: calc(56px + var(--ion-safe-area-bottom, 0px));
  height: 58px;
  left: 16px;
  right: 16px;
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(var(--ion-color-primary-rgb), 0.35);
}

.stick {
  /* Minimum 12px floor so the content isn't flush to the bottom on
     web or on devices without a safe-area inset; respects the inset
     when it exceeds the floor (notched mobiles). */
  height: calc(56px + max(var(--ion-safe-area-bottom, 0px), 12px));
  padding-bottom: max(var(--ion-safe-area-bottom, 0px), 12px);

  bottom: 0;
  left: 0;
  right: 0;
  border-top-left-radius: 5px;
  border-top-right-radius: 5px;
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}

.hidden {
  opacity: 0;
  bottom: 0;
  pointer-events: none;
}

@media (min-width: 768px) {
  .floating {
    left: 0;
    right: 0;
    width: calc(var(--lectorium-content-max-width) - 32px);
    margin-inline: auto;
  }
  .stick {
    left: 0;
    right: 0;
    width: var(--lectorium-content-max-width);
    margin-inline: auto;
  }
}

.pulsing {
  animation: inviteClick 3s ease-in-out infinite;
}

@keyframes inviteClick {
  0%,
  100% {
    transform: scale(1);
  }
  10% {
    transform: scale(0.98);
  }
  20% {
    transform: scale(1.01);
  }
  30% {
    transform: scale(0.99);
  }
  40% {
    transform: scale(1);
  }
}

.pages-viewport {
  height: 100%;
  width: 100%;
  overflow: hidden;
  touch-action: pan-y;
}

.pages-track {
  display: flex;
  height: 100%;
  width: 100%;
}

.page {
  flex: 0 0 100%;
  width: 100%;
  height: 100%;
}

.page > * {
  width: 100%;
  height: 100%;
}

.shared-play {
  position: absolute;
  top: 50%;
  left: 0;
  border-radius: 50%;
  background: var(--ion-color-primary, #2a73c2);
  color: var(--ion-color-primary-contrast, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  /* `transition` is set inline via `pointerId === null` — synced with
     `.pages-track` so the snap-back animation matches; during a drag
     the inline binding switches to "none" so the button tracks the
     finger frame-by-frame. */
  pointer-events: auto;
  z-index: 2;
}

.shared-play.disabled {
  pointer-events: none;
}

.shared-play.completed {
  opacity: 0.7;
}

.shared-play .icon {
  font-size: 1.4rem;
  z-index: 1;
}

.progress {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  overflow: visible;
  pointer-events: none;
}

.page-dots {
  position: absolute;
  bottom: 4px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  gap: 4px;
  pointer-events: none;
  z-index: 3;
}

.dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.35);
}

.dot.active {
  background: rgba(255, 255, 255, 0.85);
}
</style>
