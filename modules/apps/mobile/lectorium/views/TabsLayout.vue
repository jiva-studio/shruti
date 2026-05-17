<template>
  <IonPage>
    <IonTabs>
      <IonRouterOutlet />
      <IonTabBar slot="bottom">
        <IonTabButton tab="home" href="/tabs/home">
          <IconHome :size="26" />
        </IonTabButton>

        <IonTabButton tab="search" href="/tabs/search">
          <IconSearch :size="26" />
        </IonTabButton>

        <IonTabButton tab="chat" href="/tabs/chat" class="chat-tab-button">
          <IconAppSadhu :size="48" />
        </IonTabButton>

        <IonTabButton tab="notes" href="/tabs/notes">
          <IonSpinner v-if="shareJob.isInBackground" class="notes-tab-spinner" name="dots" />
          <IconBookmark v-else :size="26" />
        </IonTabButton>

        <IonTabButton tab="settings" href="/tabs/settings">
          <IconSettings :size="26" />
        </IonTabButton>
      </IonTabBar>
    </IonTabs>
    <!-- Закрывает гэп под ion-tab-bar в зоне safe-area-inset-bottom:
         градиент tab-bar заканчивается на границе safe-area, и без этой
         плашки под ним просвечивает контент страницы. Цвет совпадает
         с нижним стопом градиента (opacity 1.0). -->
    <div class="tab-bar-safe-area-fill" aria-hidden="true" />
  </IonPage>
</template>

<script setup lang="ts">
import { IonTabBar, IonTabButton, IonTabs, IonPage, IonRouterOutlet, IonSpinner } from "@ionic/vue"
import { IconHome, IconBookmark, IconSearch, IconSettings } from "@ui/icons/index.js"
import { useShareJobStore } from "@lectorium/stores/useShareJobStore.js"
import IconAppSadhu from "@lectorium/views/Chat/components/IconAppSadhu.vue"

// Tracks the current share job (audio or video). When isRunning flips to
// true we show a small spinner overlay on the bookmark icon — the share
// flow has handed off to background and the user knows something's still
// in flight.
const shareJob = useShareJobStore()
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
  padding-top: 12px;
}

ion-tab-button {
  --ripple-color: rgba(0, 0, 0, 0);
}

/* When the chat tab is active, just bump the disc behind the Sadhu icon
 * a bit brighter — same colour family, no ring, no halo. */
ion-tab-button.chat-tab-button.tab-selected :deep(.app-icon-wrap) {
  background: rgba(var(--ion-color-primary-rgb), 0.28);
}

.tab-bar-safe-area-fill {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: env(safe-area-inset-bottom, 0px);
  background: rgba(var(--lectorium-fade-bg-rgb), 1);
  pointer-events: none;
  /* Ниже ion-tab-bar и FloatingPlayer (~999), выше контента страницы. */
  z-index: 9;
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

/* While a background share job runs, the bookmark icon is replaced by
 * a centered spinner of the same visual weight as the icon. Sized to
 * 26px to match IconBookmark; coloured `--ion-color-step-700` so it
 * reads dark against the gradient tab bar (the default primary blue
 * was too pale). v-if/v-else swap in the template means the spinner
 * lands where the icon was — no positioning needed. */
.notes-tab-spinner {
  width: 26px;
  height: 26px;
  color: var(--ion-color-step-700, #4a4a4a);
}
</style>
