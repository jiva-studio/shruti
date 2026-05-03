<template>
  <IonPage>
    <SafeAreaHeaderGradient />

    <IonContent :fullscreen="true">
      <slot v-if="loading" name="loading">
        <IonSpinner class="spinner" name="dots" />
      </slot>
      <div v-else class="page-content">
        <slot />
      </div>

      <div v-if="reservePlayerSpace" class="placeholder" />
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
import { IonContent, IonPage, IonSpinner } from "@ionic/vue"
import SafeAreaHeaderGradient from "./SafeAreaHeaderGradient.vue"

defineProps<{
  loading?: boolean
  /** Reserves a bottom spacer matching the mini-player height when true. */
  reservePlayerSpace?: boolean
}>()
</script>

<style scoped>
ion-content {
  --padding-top: var(--ion-safe-area-top);
}

.placeholder {
  width: 100%;
  height: 35px;
}

.spinner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

/* On tablets/desktops constrain the page content to a comfortable
 * reading width and centre it. Below the breakpoint the slot stays
 * full-bleed so phone layouts are unchanged. */
@media (min-width: 768px) {
  .page-content {
    max-width: var(--shruti-content-max-width);
    margin-inline: auto;
  }
}
</style>
