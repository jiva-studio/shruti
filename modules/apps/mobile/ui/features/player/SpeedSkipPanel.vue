<template>
  <div class="speed-skip-panel">
    <SpeedSlider
      class="slider"
      :model-value="modelValue"
      :presets="presets"
      @update:model-value="(v: number) => emit('update:modelValue', v)"
      @snap="emit('snap')"
    />

    <button
      class="skip ion-activatable"
      type="button"
      aria-label="Skip back 15 seconds"
      @click.stop="emit('skipBack')"
    >
      <IconArrowBackUp class="skip-icon" :size="14" />
      <IonRippleEffect />
    </button>

    <button
      class="skip ion-activatable"
      type="button"
      aria-label="Skip forward 15 seconds"
      @click.stop="emit('skipForward')"
    >
      <IconArrowForwardUp class="skip-icon" :size="14" />
      <IonRippleEffect />
    </button>
  </div>
</template>

<script setup lang="ts">
import { IonRippleEffect } from "@ionic/vue"
import { IconArrowBackUp, IconArrowForwardUp } from "@tabler/icons-vue"
import SpeedSlider from "./SpeedSlider.vue"

defineProps<{
  modelValue: number
  presets?: readonly number[]
}>()

const emit = defineEmits<{
  "update:modelValue": [value: number]
  snap: []
  skipBack: []
  skipForward: []
}>()
</script>

<style scoped>
.speed-skip-panel {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  height: 100%;
  /* Slider on the left grows; the two skip buttons sit at the right
     edge, hugging the static Play overlay. Right padding is tight so
     skip-forward is visually adjacent to Play. */
  padding-left: 8px;
  padding-right: 0;
  gap: 4px;
}

.speed-skip-panel * {
  box-sizing: border-box;
}

.slider {
  flex: 1;
  min-width: 0;
}

.skip {
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: none;
  /* Same circular-chip feel as the Play button, just one shade
     darker than the player's tinted background, and a touch smaller
     so Play stays the visual focus. Tap feedback comes from the
     ion-ripple-effect inside, not a background swap. */
  background: var(--ion-color-primary, #c8723f);
  color: var(--ion-color-primary-contrast, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
}

.skip-icon {
  width: 14px;
  height: 14px;
}
</style>
