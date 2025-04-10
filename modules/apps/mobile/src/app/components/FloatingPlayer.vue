<template>
  <div class="floatingPlayer">
    <ion-label>Now Playing</ion-label>
    <ion-button shape="round" fill="clear" color="dark">
      <ion-icon slot="icon-only" :icon="play"></ion-icon>
    </ion-button>
  </div>
</template>

<script setup lang="ts">
import { IonButton, IonIcon } from '@ionic/vue';
import { play } from 'ionicons/icons';


</script>

<style scoped>
.floatingPlayer {
  position: fixed;
  bottom: 48px;
  left: 16px;
  right: 16px;
  height: 48px;
  background-color: var(--ion-color-light);
  color: var(--ion-color-dark);
  box-shadow: 0px 4px 10px rgba(0, 0, 0, 0.1);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>