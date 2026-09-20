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

      <div v-if="reserveBottomSpace" class="placeholder" />
    </IonContent>
  </IonPage>
</template>

<script setup lang="ts">
/**
 * A standard scrollable app page shell: `IonPage` + fullscreen `IonContent`,
 * with the safe-area fade gradient on top, a default loading spinner (override
 * via the `loading` slot) and an optional bottom spacer.
 *
 * Generic and token-driven. On wide viewports the content column is capped to
 * `--kit-page-content-max-width` and centered. When `reserveBottomSpace` is set,
 * a spacer of height `--kit-page-reserved-space` is appended so a host overlay
 * (e.g. a docked mini-player) never covers the last item — the host sets that
 * token to the overlay's height.
 */
import { IonContent, IonPage, IonSpinner } from "@ionic/vue"
import SafeAreaHeaderGradient from "./SafeAreaHeaderGradient.vue"

defineProps<{
  loading?: boolean
  /** Reserves a bottom spacer of `--kit-page-reserved-space` when true. */
  reserveBottomSpace?: boolean
}>()
</script>

<style scoped>
ion-content {
  --padding-top: var(--ion-safe-area-top);
}

/* flex-column + min-height:100% gives children a vertical box to grow
 * into — required for empty-state patterns that want `flex:1` to consume
 * the leftover viewport height. Block children still flow naturally
 * because their default `flex` keeps them at intrinsic height. */
.page-content {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.placeholder {
  width: 100%;
  /* Host-supplied reserved height (e.g. a docked overlay's visible height
   * plus the system safe-area inset), so when content is fully scrolled the
   * last item lands just above the overlay rather than under it. */
  height: var(--kit-page-reserved-space, 0px);
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
    max-width: var(--kit-page-content-max-width);
    margin-inline: auto;
  }
}
</style>
