<template>
  <IonPage>
    <!-- <div class="header" /> -->
    
    <IonContent :fullscreen="true">
      <IonSpinner
        v-show="loading"
        class="spinner"
        name="dots"
      />
      <div v-show="!loading">
        <slot />
      </div>

      <!-- <div class="placeholder" /> -->
    </IonContent>
  </IonPage>
</template>


<script setup lang="ts">
import { IonContent, IonPage, IonSpinner } from '@ionic/vue'

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
  height: 50px;
}

.header {
  position: fixed;
  left: 0px;
  right: 0px;
  top: 0px;
  height: var(--ion-safe-area-top);
  background: rgb(var(--ion-background-color-rgb, 255, 255, 255));
  z-index: 1;
}

.spinner {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}
</style>