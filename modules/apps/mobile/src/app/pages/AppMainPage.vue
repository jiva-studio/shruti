<template>
  <ion-page>
    <ion-tabs>
      <ion-router-outlet></ion-router-outlet>
      <ion-tab-bar slot="bottom">
        <ion-tab-button tab="tab1" href="/app/home">
          <ion-icon aria-hidden="true" :icon="home" />
          <ion-label>Home</ion-label>
        </ion-tab-button>

        <ion-tab-button tab="tab2" href="/app/library">
          <ion-icon aria-hidden="true" :icon="library" />
          <ion-label>Library</ion-label>
        </ion-tab-button>

        <ion-tab-button tab="tab3" href="/app/settings">
          <ion-icon aria-hidden="true" :icon="cog" />
          <ion-label>Settings</ion-label>
        </ion-tab-button>
      </ion-tab-bar>
    </ion-tabs>
  </ion-page>
</template>

<script setup lang="ts">
import { IonTabBar, IonTabButton, IonTabs, IonLabel, IonIcon, IonPage, IonRouterOutlet } from '@ionic/vue';
import { home, library, cog } from 'ionicons/icons';
</script>

<style scoped>
/**
https://codepen.io/Francesco_Maretti/pen/yLPRvXp
https://codepen.io/silas/pen/rNYqZoz
*/
/* ion-tab-bar {
  --border: 0;
  --background: linear-gradient(
    to top,
    rgba(247, 247, 247, 1) 0%,
    rgba(247, 247, 247, 0) 100%
  );
  backdrop-filter: blur(5px);
} */
</style>