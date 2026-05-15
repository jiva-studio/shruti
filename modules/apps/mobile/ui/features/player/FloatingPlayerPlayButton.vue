<template>
  <!-- Static Play overlay — anchored to the player's content-slot
       centre; never moves with the carousel. -->
  <div
    class="play-fixed"
    :class="{ completed: trackCompleted }"
    :aria-hidden="hidden"
    :style="{ '--play-button-size': size + 'px' }"
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
        start-color="rgba(255, 255, 255, .65)"
        stop-color="rgba(255, 255, 255, .65)"
        inner-stroke-color="rgba(255, 255, 255, 0)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue"
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-vue"
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

const trackCompleted = computed(() => props.duration > 0 && props.position >= props.duration)

const icon = computed(() => {
  if (trackCompleted.value) return IconRosetteDiscountCheckFilled
  return props.playing ? IconPlayerPauseFilled : IconPlayerPlayFilled
})

// The rosette glyph is denser than the play/pause triangles — bump it
// up a touch so it visually fills the button the same way.
const iconSize = computed(() => (trackCompleted.value ? 28 : 22))

function onClick(): void {
  // Done lectures shouldn't re-trigger play — only the parent's
  // "tap chrome" handler should reach the player surface to open the
  // transcript / fullscreen.
  if (trackCompleted.value) return
  emit("play")
}
</script>

<style scoped>
.play-fixed {
  position: absolute;
  top: calc(var(--content-height, 58px) / 2);
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
</style>
