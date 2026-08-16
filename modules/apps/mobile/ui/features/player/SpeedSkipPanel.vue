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
      :aria-label="t('player.skip.back', { seconds: skipSeconds })"
      @click.stop="emit('skipBack')"
    >
      <span class="skip-surface">
        <IconArrowBackUp class="skip-icon" :size="14" />
        <IonRippleEffect />
      </span>
    </button>

    <button
      class="skip ion-activatable"
      type="button"
      :aria-label="t('player.skip.forward', { seconds: skipSeconds })"
      @click.stop="emit('skipForward')"
    >
      <span class="skip-surface">
        <IconArrowForwardUp class="skip-icon" :size="14" />
        <IonRippleEffect />
      </span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { IonRippleEffect } from "@ionic/vue"
import { IconArrowBackUp, IconArrowForwardUp } from "@tabler/icons-vue"
import { useI18n } from "vue-i18n"
import SpeedSlider from "./SpeedSlider.vue"

withDefaults(
  defineProps<{
    modelValue: number
    presets?: readonly number[]
    /** Seconds a skip tap moves by — spoken in the button's accessible name.
     *  Mirrors `SKIP_DELTA_MS` in the player store, which owns the seek; this
     *  layer may not import from `shruti/`. */
    skipSeconds?: number
  }>(),
  { skipSeconds: 15 }
)

const emit = defineEmits<{
  "update:modelValue": [value: number]
  snap: []
  skipBack: []
  skipForward: []
}>()

const { t } = useI18n()
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
  width: 26px;
  height: 26px;
  border: none;
  background: none;
  color: inherit;
  display: flex;
  cursor: pointer;
  padding: 0;
}

/* Touch target, not paint. The visible chip stays 26px (26×26 clears
   WCAG 2.2 AA's 24×24 but not Apple's 44pt / Material's 48dp), so the
   hit area is grown with a transparent overlay instead of the box:
   44px tall — the player's content slot is 58px, so it fits — and 30px
   wide, which swallows the 4px gap and stops exactly at the neighbour's
   edge. Wider would overlap the sibling skip / the Play overlay, and
   whichever paints last would simply steal the taps back. */
.skip::after {
  content: "";
  position: absolute;
  inset: -9px -2px;
}

/* The ripple's clip lives here rather than on the button, because
   `overflow: hidden` on the button would also clip the hit-area
   pseudo-element above — clipping removes a region from hit testing,
   not just from painting. `ion-activatable` stays on the button (Ionic
   walks *up* to find it) and finds this ripple by descendant query. */
.skip-surface {
  position: relative;
  overflow: hidden;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  /* Same circular-chip feel as the Play button, just one shade
     darker than the player's tinted background, and a touch smaller
     so Play stays the visual focus. Tap feedback comes from the
     ion-ripple-effect inside, not a background swap. */
  background: var(--ion-color-primary, #c8723f);
  color: var(--ion-color-primary-contrast, #fff);
  display: flex;
  align-items: center;
  justify-content: center;
}

.skip:focus-visible {
  outline: 2px solid var(--ion-color-primary-contrast, #fff);
  outline-offset: 2px;
  border-radius: 50%;
}

.skip-icon {
  width: 14px;
  height: 14px;
}
</style>
