<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-title>Tab 1</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <ion-header collapse="condense">
        <ion-toolbar>
          <ion-title size="large">Tab 1</ion-title>
        </ion-toolbar>
      </ion-header>

      <ion-list>
        <ion-item href="/app/library/1">
          <ion-label>Item 1</ion-label>
        </ion-item>
        <ion-item href="/app/library/2">
          <ion-label>Item 2</ion-label>
        </ion-item>
        <ion-item href="/app/library/3">
          <ion-label>Item 3</ion-label>
        </ion-item>
        <ion-item href="/app/library/4">
          <ion-label>Item 4</ion-label>
        </ion-item>
      </ion-list>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { IonPage, IonHeader, IonToolbar, IonTitle, IonContent } from '@ionic/vue';
import ExploreContainer from '@/app/components/ExploreContainer.vue';
</script>
