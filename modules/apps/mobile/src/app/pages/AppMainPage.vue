<template>
  <IonPage>
    <IonTabs>
      <IonRouterOutlet />
      <IonTabBar slot="bottom">
        <IonTabButton
          tab="tab1"
          href="/app/home"
        >
          <IconHome />
          <IonLabel>Home</IonLabel>
        </IonTabButton>

        <IonTabButton
          tab="tab2"
          href="/app/library"
        >
          <IconSearch />
          <IonLabel>Library</IonLabel>
        </IonTabButton>

        <IonTabButton
          tab="tab3"
          href="/app/settings"
        >
          <IconSettings />
          <IonLabel>Settings</IonLabel>
        </IonTabButton>
      </IonTabBar>
    </IonTabs>
  </IonPage>
</template>

<script setup lang="ts">
import { IonTabBar, IonTabButton, IonTabs, IonLabel, IonPage, IonRouterOutlet } from '@ionic/vue'
import { IconHome, IconSearch, IconSettings } from '@/app'
</script>

<style scoped>
ion-tab-bar {
  --border: 0;
  --background: linear-gradient(
    to bottom,
    rgba(var(--ion-background-color-rgb, 255, 255, 255), 0)   0%,
    rgba(var(--ion-background-color-rgb, 255, 255, 255), .8) 35%,
    rgba(var(--ion-background-color-rgb, 255, 255, 255), 1)  100%
  );
  padding-top: 50px;
}

ion-tab-button {
  --ripple-color: rgba(0, 0, 0, 0);
}
</style>