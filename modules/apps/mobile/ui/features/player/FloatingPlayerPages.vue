<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import MixControl from "./MixControl.vue"
import PlayerControls from "./PlayerControls.vue"
import SpeedSkipPanel from "./SpeedSkipPanel.vue"

const props = defineProps<{
  title: string
  author: string
  mixPosition: number
  playbackSpeed: number
  /** Carousel page in view, and the live drag on top of it (px). */
  page: number
  dragOffset: number
  /** `null` when no drag is in flight — then the track snaps instead. */
  pointerId: number | null
}>()

const emit = defineEmits<{
  "update:mixPosition": [value: number]
  "mix-tick": []
  "update:playbackSpeed": [value: number]
  "speed-tick": []
  "skip-back": []
  "skip-forward": []
}>()

const { t } = useI18n()

const viewport = ref<HTMLElement | null>(null)

const trackStyle = computed(() => ({
  transform: `translateY(calc(${-props.page * 100}% + ${props.dragOffset}px))`,
  transition: props.pointerId === null ? "transform 0.25s ease-out" : "none",
}))

defineExpose({ viewportEl: (): HTMLElement | null => viewport.value })
</script>

<template>
  <div ref="viewport" class="pages-viewport">
    <div class="pages-track" :style="trackStyle">
      <div class="page">
        <MixControl
          :model-value="mixPosition"
          :left-label="t('player.mix.left')"
          :right-label="t('player.mix.right')"
          @update:model-value="(v: number) => emit('update:mixPosition', v)"
          @tick="emit('mix-tick')"
        />
      </div>
      <div class="page">
        <PlayerControls :title="title" :author="author" />
      </div>
      <div class="page">
        <SpeedSkipPanel
          :model-value="playbackSpeed"
          @update:model-value="(v: number) => emit('update:playbackSpeed', v)"
          @snap="emit('speed-tick')"
          @skip-back="emit('skip-back')"
          @skip-forward="emit('skip-forward')"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
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

/* The three pages overflow the track vertically and the viewport clips them;
   translateY(-N * 100%) brings page N into view. */
.pages-track {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
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
