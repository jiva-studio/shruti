<template>
  <IonContent class="ion-padding">
    <div class="safe-padding">
      <slot />
    </div>
  </IonContent>
</template>


<script setup lang="ts">
import { IonContent } from '@ionic/vue'
</script>


<style scoped>
.safe-padding {
  padding-top: var(--ion-safe-area-top, 2rem);
  padding-bottom: var(--ion-safe-area-bottom, 2rem);
}
</style>
