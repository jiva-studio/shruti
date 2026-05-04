<template>
  <div class="speed-skip-panel">
    <!-- Reserved slot under which the FloatingPlayer's shared Play
         button sits when this page is the active one. The slot
         exists in the layout so the row hugs the right edge of the
         viewport instead of sliding under Play. -->
    <div class="play-slot" :style="{ width: playSlotWidth + 'px' }" />

    <button
      class="skip"
      type="button"
      aria-label="Skip back 15 seconds"
      @click.stop="emit('skipBack')"
    >
      <IonIcon :icon="playSkipBackOutline" />
    </button>

    <SpeedSlider
      class="slider"
      :model-value="modelValue"
      :presets="presets"
      @update:model-value="(v: number) => emit('update:modelValue', v)"
      @snap="(v: number) => emit('snap', v)"
    />

    <button
      class="skip"
      type="button"
      aria-label="Skip forward 15 seconds"
      @click.stop="emit('skipForward')"
    >
      <IonIcon :icon="playSkipForwardOutline" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { IonIcon } from "@ionic/vue"
import { playSkipBackOutline, playSkipForwardOutline } from "ionicons/icons"
import SpeedSlider from "./SpeedSlider.vue"

withDefaults(
  defineProps<{
    modelValue: number
    presets?: readonly number[]
    /** Width of the Play-button slot reserved on the left. Should
     *  match FloatingPlayer's playButtonSize so the slot lines up
     *  with where the shared overlay drops the button. */
    playSlotWidth?: number
  }>(),
  {
    playSlotWidth: 44,
  }
)

const emit = defineEmits<{
  "update:modelValue": [value: number]
  snap: [value: number]
  skipBack: []
  skipForward: []
}>()
</script>

<style scoped>
.speed-skip-panel {
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
  padding: 0 8px 0 8px;
  gap: 4px;
}

.play-slot {
  flex-shrink: 0;
  height: 100%;
}

.slider {
  flex: 1;
  min-width: 0;
}

.skip {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: var(--ion-color-primary-contrast, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 1.4rem;
  padding: 0;
  /* Eat just the click; carousel needs pointerdown to bubble so a
     drag started here can still page-swipe (a tap stays under the
     8 px lock threshold and doesn't trigger the swipe). */
}

.skip:active {
  background: rgba(255, 255, 255, 0.18);
}
</style>
