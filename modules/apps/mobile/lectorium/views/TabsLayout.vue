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
          <div class="chat-icon-wrap">
            <IconAppSadhu :size="48" />
            <span v-if="proactiveBadge.count.value > 0" class="proactive-dot" />
          </div>
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
import { watch } from "vue"
import router from "@lectorium/router/index.js"
import { IonTabBar, IonTabButton, IonTabs, IonPage, IonRouterOutlet, IonSpinner } from "@ionic/vue"
import { IconHome, IconBookmark, IconSearch, IconSettings } from "@ui/icons/index.js"
import { useShareJobStore } from "@lectorium/stores/useShareJobStore.js"
import { useProactiveInboxBadge } from "@lectorium/composables/useProactiveInboxBadge.js"
import IconAppSadhu from "@lectorium/views/Chat/components/IconAppSadhu.vue"

// Tracks the current share job (audio or video). When isRunning flips to
// true we show a small spinner overlay on the bookmark icon — the share
// flow has handed off to background and the user knows something's still
// in flight.
const shareJob = useShareJobStore()

const proactiveBadge = useProactiveInboxBadge()

// `useRoute()` is unreliable here: during initial setup the underlying
// Vue Router DI ref can be `undefined`, which freezes the badge watcher
// (it reads `undefined?.name` forever). Same fix as the action-handler
// composables — use the singleton `router.currentRoute` and read `.value`.
function isChatRoute(): boolean {
  const name = router.currentRoute.value?.name
  return name === "chat" || name === "chat-session"
}
// Clear the proactive badge when the user enters any chat route — the
// landing chat tab counts as "seen". Watch by name so deep links into
// a specific session ("chat-session") also reset the badge.
watch(
  () => router.currentRoute.value?.name,
  (name) => {
    if (name === "chat" || name === "chat-session") {
      void proactiveBadge.markSeen()
    }
  },
  { immediate: true }
)
// Companion path: the user is already on the chat tab when the
// scheduler creates a new proactive row. The route doesn't change, so
// the watcher above never fires — without this, the dot appears and
// stays until the user navigates away and back. Advance the watermark
// as soon as the count goes positive while we are on chat.
watch(
  () => proactiveBadge.count.value,
  (next) => {
    if (next > 0 && isChatRoute()) {
      void proactiveBadge.markSeen()
    }
  }
)
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

.chat-icon-wrap {
  position: relative;
  display: inline-block;
}

/* Tiny "unread" dot on the Sadhu icon. No count — a single dot reads
 * cleaner with the round chat-tab disc and avoids tail behaviour when
 * the count overflows two digits. */
.proactive-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--ion-color-warning, #ffc409);
  border: 2px solid var(--ion-background-color, #fff);
  pointer-events: none;
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
