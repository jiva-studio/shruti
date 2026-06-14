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
    @pointerdown="onShellPointerDown"
    @click="onClick"
  >
    <FloatingPlayerPageDots :page="page" :count="pageCount" :hidden="hidden" />

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
        <div v-if="sourceMixAvailable" class="page">
          <SourceMixControl
            :model-value="sourceMixLevel"
            :left-label="t('player.sourceMix.original')"
            :right-label="t('player.sourceMix.clean')"
            @update:model-value="(v: number) => emit('update:sourceMixLevel', v)"
            @tick="emit('sourceMixTick')"
          />
        </div>
      </div>
    </div>

    <FloatingPlayerPlayButton
      :playing="playing"
      :hidden="hidden"
      :position="position"
      :duration="duration"
      :show-progress="showProgress"
      :size="playButtonSize"
      @play="emit('playClicked')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import MixControl from "./MixControl.vue"
import SourceMixControl from "./SourceMixControl.vue"
import PlayerControls from "./PlayerControls.vue"
import SpeedSkipPanel from "./SpeedSkipPanel.vue"
import FloatingPlayerPageDots from "./FloatingPlayerPageDots.vue"
import FloatingPlayerPlayButton from "./FloatingPlayerPlayButton.vue"
import { useVerticalCarousel } from "./useVerticalCarousel.js"

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
    /** Source-mix level [0,1]: 0 = original, 1 = clean. */
    sourceMixLevel?: number
    /** Show the original↔clean slide (only when the track has both). */
    sourceMixAvailable?: boolean
    /** Diameter (px) of the static Play button. */
    playButtonSize?: number
  }>(),
  { playButtonSize: 44, sourceMixLevel: 0, sourceMixAvailable: false }
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
  "update:sourceMixLevel": [value: number]
  /** Light haptic when the source-mix puck reaches an endpoint. */
  sourceMixTick: []
  skipBack: []
  skipForward: []
}>()

// 3 pages normally (mix / controls / speed); a 4th source-mix slide appears
// only when the track has both an original and a clean audio version.
const pageCount = computed(() => (props.sourceMixAvailable ? 4 : 3))
const viewport = ref<HTMLElement | null>(null)
// Default to the centre page (title/author). Mix is page 0 (top), speed
// is page 2 — swipe up reveals speed, swipe down reveals mix.
const { page, dragOffset, pointerId, onPointerDown, consumeVerticalGesture } = useVerticalCarousel({
  pageCount: () => pageCount.value,
  initialPage: 1,
  viewportEl: () => viewport.value,
})

// When the source-mix slide disappears (track without clean), clamp the
// current page so we never sit on a page that no longer exists.
watch(pageCount, (count) => {
  if (page.value > count - 1) page.value = count - 1
})

function onShellPointerDown(e: PointerEvent): void {
  if (props.hidden) return
  onPointerDown(e)
}

function onClick(): void {
  // Suppress the synthesised click that follows a vertical page swipe
  // — only taps on the free area should open the fullscreen view.
  if (consumeVerticalGesture()) return
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
</style>
