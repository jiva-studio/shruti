<template>
  <IonPage>
    <IonTabs>
      <IonRouterOutlet />
      <IonTabBar slot="bottom">
        <IonTabButton tab="home" href="/tabs/home">
          <IconHome />
          <IonLabel>{{ $t("app.home") }}</IonLabel>
        </IonTabButton>

        <IonTabButton tab="search" href="/tabs/search">
          <IconSearch />
          <IonLabel>{{ $t("app.search") }}</IonLabel>
        </IonTabButton>

        <IonTabButton v-if="showNotesTab" tab="notes" href="/tabs/notes">
          <IconBookmark />
          <IonLabel>{{ $t("app.notes") }}</IonLabel>
        </IonTabButton>

        <IonTabButton tab="settings" href="/tabs/settings">
          <IconSettings />
          <IonLabel>{{ $t("app.settings") }}</IonLabel>
        </IonTabButton>
      </IonTabBar>
    </IonTabs>
  </IonPage>
</template>

<script setup lang="ts">
import { IonTabBar, IonTabButton, IonTabs, IonLabel, IonPage, IonRouterOutlet } from "@ionic/vue"
import { IconHome, IconBookmark, IconSearch, IconSettings } from "@ui/icons/index.js"
import { useConfig } from "@lectorium/composables/useConfig.js"

const showNotesTab = useConfig<boolean>("settings.notes.showTab", true)
</script>

<style scoped>
ion-tab-bar {
  --border: 0;
  --background: linear-gradient(
    to bottom,
    rgba(var(--lectorium-fade-bg-rgb), 0) 0%,
    rgba(var(--lectorium-fade-bg-rgb), 0.8) 35%,
    rgba(var(--lectorium-fade-bg-rgb), 1) 100%
  );
  padding-top: 50px;
}

ion-tab-button {
  --ripple-color: rgba(0, 0, 0, 0);
}
</style>

<style>
.badge {
  width: 8px;
  height: 8px;
  position: absolute;
  background-color: var(--ion-color-danger);
  border-radius: 8px;
  top: 12%;
  right: 33%;
}
</style>
