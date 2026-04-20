<template>
  <IonPage>
    <div class="header" />

    <IonContent :fullscreen="true">
      <IonSpinner
        v-show="loading"
        class="spinner"
        name="dots"
      />
      <div v-show="!loading">
        <slot />
      </div>

      <div
        v-if="playerOpen"
        class="placeholder"
      />
    </IonContent>
  </IonPage>
</template>


<script setup lang="ts">
import { IonContent, IonPage, IonSpinner } from '@ionic/vue'
import { usePlayerStore } from '@shruti/stores/usePlayerStore.js'
import { computed } from 'vue'

const player = usePlayerStore()
const playerOpen = computed(() => player.open)

/* -------------------------------------------------------------------------- */
/*                                  Interface                                 */
/* -------------------------------------------------------------------------- */

defineProps<{
  loading?: boolean
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

.header {
  position: fixed;
  left: 0px;
  right: 0px;
  top: 0px;
  height: var(--ion-safe-area-top);
  background: linear-gradient(
    to bottom,
    rgba(var(--ion-background-color-rgb, 255, 255, 255),  1) 0%,
    rgba(var(--ion-background-color-rgb, 255, 255, 255), .8) 35%,
    rgba(var(--ion-background-color-rgb, 255, 255, 255),  0) 100%
  );
  z-index: 1;
}

.spinner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
</style>
