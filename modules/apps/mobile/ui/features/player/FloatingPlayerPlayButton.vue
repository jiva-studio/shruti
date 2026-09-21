<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue"
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
import { useI18n } from "vue-i18n"
import { IconRosetteDiscountCheckFilled } from "@ui/icons/index.js"
import RadialProgress from "vue3-radial-progress"

const props = defineProps<{
  playing: boolean
  /** True when the FloatingPlayer is in its `hidden` state. */
  hidden: boolean
  position: number
  duration: number
  /** Render the radial progress ring around the icon. */
  showProgress: boolean
  /** Diameter (px) of the button + progress ring. */
  size: number
}>()

const emit = defineEmits<{
  play: []
}>()

const sizeStyle = computed(() => ({ "--play-button-size": `${props.size}px` }))

// The progress ring is an SVG `stop-color` attribute, which can't read a
// CSS variable via var(). Resolve --ion-color-primary-contrast from the
// computed style instead, and re-resolve on theme change so the ring tracks
// the saffron play-button's contrast colour in both light and dark themes.
const ringColor = ref("rgba(255, 255, 255, .65)")

function resolveRingColor(): void {
  const c = getComputedStyle(document.documentElement)
    .getPropertyValue("--ion-color-primary-contrast")
    .trim()
  if (c) ringColor.value = c
}

const darkQuery =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null

onMounted(() => {
  resolveRingColor()
  darkQuery?.addEventListener("change", resolveRingColor)
})

onUnmounted(() => {
  darkQuery?.removeEventListener("change", resolveRingColor)
})

const trackCompleted = computed(() => props.duration > 0 && props.position >= props.duration)

const icon = computed(() => {
  if (trackCompleted.value) return IconRosetteDiscountCheckFilled
  return props.playing ? IconPlayerPauseFilled : IconPlayerPlayFilled
})

// The rosette glyph is denser than the play/pause triangles — bump it
// up a touch so it visually fills the button the same way.
const iconSize = computed(() => (trackCompleted.value ? 28 : 22))

const { t } = useI18n()

// The accessible name follows the glyph: a screen reader announces what a
// tap will do, and "finished" for the completed state, whose tap does
// nothing (see onClick).
const label = computed(() => {
  if (trackCompleted.value) return t("player.completed")
  return props.playing ? t("player.pause") : t("player.play")
})

function onClick(): void {
  // Done lectures shouldn't re-trigger play — only the parent's
  // "tap chrome" handler should reach the player surface to open the
  // transcript / fullscreen.
  if (trackCompleted.value) return
  emit("play")
}
</script>

<template>
  <!-- Static Play overlay — anchored to the player's content-slot
       centre; never moves with the carousel.

       A real <button>, not a styled div: this is the app's most-used
       control, and the element is what hands a screen reader the role
       and the keyboard the focus. `tabindex="-1"` while hidden keeps it
       out of the tab order for the (frequent) case where nothing is
       playing — an aria-hidden element must never be focusable. -->
  <button
    class="play-fixed"
    type="button"
    :class="{ completed: trackCompleted, hidden }"
    :aria-hidden="hidden"
    :aria-label="label"
    :tabindex="hidden ? -1 : 0"
    :style="sizeStyle"
    @pointerdown.stop
    @click.stop="onClick"
  >
    <component :is="icon" class="icon" :size="iconSize" />
    <div v-if="showProgress && !trackCompleted" class="progress">
      <RadialProgress
        :stroke-width="4"
        :inner-stroke-width="4"
        :diameter="size"
        :completed-steps="position"
        :total-steps="duration"
        :animate-speed="750"
        :start-color="ringColor"
        :stop-color="ringColor"
        inner-stroke-color="rgba(255, 255, 255, 0)"
      />
    </div>
  </button>
</template>

<style scoped>
.play-fixed {
  position: absolute;
  top: calc(var(--content-height, 58px) / 2);
  right: 8px;
  transform: translateY(-50%);
  width: var(--play-button-size);
  height: var(--play-button-size);
  /* Button resets — the element is a <button> for role and focus; the
     circle below is the whole of its appearance. */
  appearance: none;
  border: none;
  padding: 0;
  font: inherit;
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

.play-fixed:focus-visible {
  outline: 2px solid var(--ion-color-primary-contrast, #fff);
  outline-offset: 2px;
}

/* Parent FloatingPlayer drops pointer-events on .hidden, but children
 * with explicit pointer-events: auto (this button) re-enable click
 * capture even when invisible — taps in the player's screen region
 * fall through to the play handler instead of reaching elements
 * underneath (chat input bar, suggestion chips, …). Match the parent
 * here so a hidden player is fully click-inert. */
.play-fixed.hidden {
  pointer-events: none;
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
</style>
