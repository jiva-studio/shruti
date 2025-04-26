<template>
  <IonPage>
    <!-- <div class="header" /> -->
    
    <IonContent :fullscreen="true">
      <slot />
      <!-- <div class="placeholder" /> -->
    </IonContent>
  </IonPage>
</template>


<script setup lang="ts">
import { IonContent, IonPage } from '@ionic/vue'
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
</style>