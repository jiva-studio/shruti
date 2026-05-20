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

/* flex-column + min-height:100% gives children a vertical box to grow
 * into — required for empty-state patterns (e.g. PlaylistSection)
 * that want `flex:1` to consume the leftover viewport height. Block
 * children still flow naturally because their default `flex` keeps
 * them at intrinsic height. */
.page-content {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.placeholder {
  width: 100%;
  /* Matches the floating mini-player's visible height (see
   * FloatingPlayer.vue `.floating { height: 58px }`) plus the
   * system safe-area inset, so when content is fully scrolled the
   * last item (e.g. the Settings version label) lands just above
   * the player rather than under it. */
  height: calc(58px + env(safe-area-inset-bottom, 0px));
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
