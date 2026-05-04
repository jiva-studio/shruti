<template>
  <!-- No Teleport: the parent (App.vue) renders us directly inside
       <IonApp>, which is the same DOM container Ionic mounts its
       overlays into (action-sheet, alert, modal, toast, popover —
       see @ionic/core .../overlays.js: getAppRoot returns ion-app).
       Sitting in the same container means Ionic's :host z-index: 1001
       actually competes with our z-index — see .player below. -->
  <div
    :class="{
      player: true,
      floating: !sticked,
      stick: sticked,
      hidden: hidden,
      pulsing: pulsing,
    }"
    :style="{ '--play-button-size': playButtonSize + 'px' }"
    @pointerdown="onPointerDown"
    @click="onClick"
  >
    <div class="page-dots" :aria-hidden="hidden">
      <span :class="{ dot: true, active: page === 0 }" />
      <span :class="{ dot: true, active: page === 1 }" />
      <span :class="{ dot: true, active: page === 2 }" />
    </div>

    <div ref="viewport" class="pages-viewport">
      <div
        class="pages-track"
        :style="{
          transform: `translateY(calc(${-page * 100}% + ${dragOffset}px))`,
          transition: pointerId === null ? 'transform 0.25s ease-out' : 'none',
        }"
      >
        <div class="page">
          <MixControl
            :model-value="mixPosition"
            :left-label="t('player.mix.left')"
            :right-label="t('player.mix.right')"
            @update:model-value="(v: number) => emit('update:mixPosition', v)"
            @tick="emit('mixTick')"
          />
        </div>
        <div class="page">
          <PlayerControls :title="title" :author="author" />
        </div>
        <div class="page">
          <SpeedSkipPanel
            :model-value="playbackSpeed"
            @update:model-value="(v: number) => emit('update:playbackSpeed', v)"
            @snap="emit('speedTick')"
            @skip-back="emit('skipBack')"
            @skip-forward="emit('skipForward')"
          />
        </div>
      </div>
    </div>

    <!-- Static Play overlay — never moves with the carousel; visible on
         every page. Lives outside .pages-viewport so swipe-translate
         can't push it around. -->
    <div
      class="play-fixed"
      :class="{ completed: trackCompleted }"
      :aria-hidden="hidden"
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
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue"
import { useI18n } from "vue-i18n"
import { IonIcon } from "@ionic/vue"
import { play, pause, checkmarkDone } from "ionicons/icons"
import RadialProgress from "vue3-radial-progress"
import MixControl from "./MixControl.vue"
import PlayerControls from "./PlayerControls.vue"
import SpeedSkipPanel from "./SpeedSkipPanel.vue"

const { t } = useI18n()

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
    /** Diameter (px) of the static Play button. */
    playButtonSize?: number
  }>(),
  { playButtonSize: 44 }
)

const emit = defineEmits<{
  playClicked: []
  click: []
  "update:mixPosition": [value: number]
  /** Single haptic-tick channel for the mix slider — fires on detent
   *  engage, disengage, and visible snap-back. App.vue maps this to
   *  one light haptic regardless of cause. */
  mixTick: []
  "update:playbackSpeed": [value: number]
  /** Same idea for the speed slider — fires when the puck enters a
   *  new nearest-preset zone during drag. */
  speedTick: []
  skipBack: []
  skipForward: []
}>()

/* -------------------------------------------------------------------------- */
/*                                    State                                   */
/* -------------------------------------------------------------------------- */

const viewport = ref<HTMLElement | null>(null)
// Default to the centre page (title/author). Mix is page 0 (top), speed
// is page 2 (bottom) — swipe up reveals speed, swipe down reveals mix.
const page = ref<number>(1)
const dragOffset = ref<number>(0)
const PAGE_COUNT = 3

/* -------------------------------------------------------------------------- */
/*                              Vertical swipe                                */
/* -------------------------------------------------------------------------- */

const pointerId = ref<number | null>(null)
// Pointer position at the start of a drag gesture. Used only to compute
// the displacement (dx, dy) from the origin for direction-locking and
// drag-offset translation — never read on its own.
let gestureOriginX = 0
let gestureOriginY = 0
let dragLocked: "horizontal" | "vertical" | null = null
const DRAG_LOCK_THRESHOLD = 8 // px before deciding direction
const PAGE_SWITCH_THRESHOLD = 0.25 // fraction of page height

function onPointerDown(e: PointerEvent): void {
  if (props.hidden) return
  pointerId.value = e.pointerId
  gestureOriginX = e.clientX
  gestureOriginY = e.clientY
  dragLocked = null
  window.addEventListener("pointermove", onPointerMove)
  window.addEventListener("pointerup", onPointerUp)
  window.addEventListener("pointercancel", onPointerUp)
}

function onPointerMove(e: PointerEvent): void {
  if (e.pointerId !== pointerId.value) return
  const dx = e.clientX - gestureOriginX
  const dy = e.clientY - gestureOriginY
  if (dragLocked === null) {
    if (Math.abs(dx) < DRAG_LOCK_THRESHOLD && Math.abs(dy) < DRAG_LOCK_THRESHOLD) return
    // Vertical swipe drives the carousel. Horizontal: leave it alone —
    // an inner slider may want it (mix puck, speed puck), and any other
    // horizontal drag is just noise.
    dragLocked = Math.abs(dy) > Math.abs(dx) ? "vertical" : "horizontal"
    if (dragLocked === "horizontal") {
      cleanupDrag()
      return
    }
  }
  // Resist swiping past the first / last page so the user feels the
  // boundary instead of seeing the empty space above page 0 / below
  // page 2.
  let offset = dy
  if (page.value === 0 && dy > 0) offset = dy * 0.3
  if (page.value === PAGE_COUNT - 1 && dy < 0) offset = dy * 0.3
  dragOffset.value = offset
}

function onPointerUp(e: PointerEvent): void {
  if (e.pointerId !== pointerId.value) return
  if (dragLocked === "vertical" && viewport.value) {
    const h = viewport.value.getBoundingClientRect().height
    if (h > 0) {
      const ratio = dragOffset.value / h
      if (ratio < -PAGE_SWITCH_THRESHOLD && page.value < PAGE_COUNT - 1) page.value += 1
      else if (ratio > PAGE_SWITCH_THRESHOLD && page.value > 0) page.value -= 1
    }
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
/*                              Play overlay                                  */
/* -------------------------------------------------------------------------- */

const trackCompleted = computed(() => props.duration > 0 && props.position >= props.duration)
const playIcon = computed(() => {
  if (trackCompleted.value) return checkmarkDone
  return props.playing ? pause : play
})

function onPlayClick(): void {
  if (trackCompleted.value) return
  emit("playClicked")
}

/* -------------------------------------------------------------------------- */
/*                                    Misc                                    */
/* -------------------------------------------------------------------------- */

function onClick(): void {
  // Suppress the synthesised click that follows a vertical page swipe
  // — only taps on the free area should open the fullscreen view.
  if (dragLocked === "vertical") {
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
  /* Height of the actual content slot (carousel + Play + dots). This
     stays constant across floating ↔ stick. In stick mode the player's
     own height is taller, but the extra space is added BELOW this slot
     (filling the area where the tab bar used to be plus the safe-area
     inset). That way Play/dots/carousel never animate vertically when
     the player toggles modes — only the bottom extension grows. */
  --content-height: 58px;
}

.floating {
  bottom: calc(56px + var(--ion-safe-area-bottom, 0px));
  height: var(--content-height);
  left: 16px;
  right: 16px;
  border-radius: 10px;
  box-shadow: 0 4px 16px rgba(var(--ion-color-primary-rgb), 0.35);
}

.stick {
  /* Compact stick: same content slot as floating, plus a thin safe-area
     extension at the bottom for notched devices. Carousel/Play/dots
     are anchored to the top half so they don't re-centre during the
     mode transition — the safe-area inset just grows beneath them. */
  bottom: 0;
  height: calc(var(--content-height) + max(var(--ion-safe-area-bottom, 0px), 12px));
  padding-bottom: max(var(--ion-safe-area-bottom, 0px), 12px);

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
    width: calc(var(--shruti-content-max-width) - 32px);
    margin-inline: auto;
  }
  .stick {
    left: 0;
    right: 0;
    width: var(--shruti-content-max-width);
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
  position: relative;
  width: 100%;
  /* Pinned to the content slot at the player's top — never grows into
     the stick mode's bottom extension. */
  height: var(--content-height);
  /* Reserve space for vertical page-dots on the left and the static
     Play button on the right. Carousel content lives in the middle. */
  padding-left: 14px;
  padding-right: calc(var(--play-button-size) + 12px);
  box-sizing: border-box;
  overflow: hidden;
  /* Vertical swipe drives the carousel — block the browser's native
     pan so we get full ownership of the gesture. */
  touch-action: pan-x;
}

.pages-track {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  /* Children overflow the track's box vertically (3 × height stuffed
     into 1 × height with shrink: 0); the viewport's overflow:hidden
     clips them. translateY(-N * 100%) moves the track up by N pages
     to bring page N into the visible area — same trick the horizontal
     carousel used with translateX. */
}

.page {
  flex: 0 0 100%;
  width: 100%;
}

.page > * {
  width: 100%;
  height: 100%;
}

.play-fixed {
  position: absolute;
  /* Anchor to the centre of the *content slot* (top portion of the
     player). In stick mode the player itself is taller, but Play
     stays put — the extra height grows below it. */
  top: calc(var(--content-height) / 2);
  right: 8px;
  transform: translateY(-50%);
  width: var(--play-button-size);
  height: var(--play-button-size);
  border-radius: 50%;
  background: var(--ion-color-primary, #2a73c2);
  color: var(--ion-color-primary-contrast, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  pointer-events: auto;
  z-index: 2;
}

.play-fixed.completed {
  opacity: 0.7;
}

.play-fixed .icon {
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
  /* Same content-slot centring as .play-fixed — anchored to the top
     58 px so it doesn't drift when stick mode extends the player. */
  top: calc(var(--content-height) / 2);
  left: 6px;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
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
