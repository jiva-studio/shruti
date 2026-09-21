<script setup lang="ts">
import { computed, useTemplateRef } from "vue"
import FloatingPlayerPages from "./FloatingPlayerPages.vue"
import FloatingPlayerPageDots from "./FloatingPlayerPageDots.vue"
import FloatingPlayerPlayButton from "./FloatingPlayerPlayButton.vue"
import { useVerticalCarousel } from "./useVerticalCarousel.js"

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
  "play-clicked": []
  click: []
  "update:mixPosition": [value: number]
  /** Single haptic-tick channel for the mix slider — fires on detent
   *  engage, disengage, and visible snap-back. App.vue maps this to
   *  one light haptic regardless of cause. */
  "mix-tick": []
  "update:playbackSpeed": [value: number]
  /** Same idea for the speed slider — fires when the puck enters a
   *  new nearest-preset zone during drag. */
  "speed-tick": []
  "skip-back": []
  "skip-forward": []
}>()
const shellStyle = computed(() => ({ "--play-button-size": `${props.playButtonSize}px` }))

const PAGE_COUNT = 3
const pages = useTemplateRef<{ viewportEl: () => HTMLElement | null }>("pages")
// Default to the centre page (title/author). Mix is page 0 (top), speed
// is page 2 (bottom) — swipe up reveals speed, swipe down reveals mix.
const { page, dragOffset, pointerId, onPointerDown, consumeVerticalGesture } = useVerticalCarousel({
  pageCount: PAGE_COUNT,
  initialPage: 1,
  viewportEl: () => pages.value?.viewportEl() ?? null,
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

<template>
  <!-- No Teleport: we sit in ion-app, the same container Ionic mounts its
       overlays into, so our z-index actually competes with theirs. -->
  <div
    :class="{
      player: true,
      floating: !sticked,
      stick: sticked,
      hidden: hidden,
      pulsing: pulsing,
    }"
    :aria-hidden="hidden"
    :style="shellStyle"
    @pointerdown="onShellPointerDown"
    @click="onClick"
  >
    <FloatingPlayerPageDots :page="page" :count="PAGE_COUNT" :hidden="hidden" />

    <FloatingPlayerPages
      ref="pages"
      :title="title"
      :author="author"
      :mix-position="mixPosition"
      :playback-speed="playbackSpeed"
      :page="page"
      :drag-offset="dragOffset"
      :pointer-id="pointerId"
      @update:mix-position="(v: number) => emit('update:mixPosition', v)"
      @mix-tick="emit('mix-tick')"
      @update:playback-speed="(v: number) => emit('update:playbackSpeed', v)"
      @speed-tick="emit('speed-tick')"
      @skip-back="emit('skip-back')"
      @skip-forward="emit('skip-forward')"
    />

    <FloatingPlayerPlayButton
      :playing="playing"
      :hidden="hidden"
      :position="position"
      :duration="duration"
      :show-progress="showProgress"
      :size="playButtonSize"
      @play="emit('play-clicked')"
    />
  </div>
</template>

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
</style>
